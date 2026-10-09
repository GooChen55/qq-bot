"""One-shot stem separation. Exit frees GPU before the RVC worker starts."""
import argparse
import contextlib
import json
import logging
import hashlib
import os
import sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--input')
parser.add_argument('--output', required=True)
parser.add_argument('--models', required=True)
parser.add_argument('--model', default='UVR-MDX-NET-Inst_HQ_3.onnx')
parser.add_argument('--prepare', action='store_true')
args = parser.parse_args()
bundled_ffmpeg = Path(__file__).resolve().parent.parent / 'runtimes' / 'GPT-SoVITS-v3lora-20250228'
if (bundled_ffmpeg / 'ffmpeg.exe').is_file():
    os.environ['PATH'] = str(bundled_ffmpeg) + os.pathsep + os.environ.get('PATH', '')
try:
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        import onnxruntime as ort
        # Torch's DLLs must be loaded before ORT creates its CUDA session.
        if hasattr(ort, 'preload_dlls'):
            ort.preload_dlls(directory=str(Path(torch.__file__).parent / 'lib'))
        providers = []
        original_session = ort.InferenceSession
        class VerifiedSession(original_session):
            def __init__(self, *values, **options):
                super().__init__(*values, **options)
                actual = self.get_providers()
                providers.extend(actual)
                if torch.cuda.is_available() and 'CUDAExecutionProvider' not in actual:
                    raise RuntimeError('ONNX CUDA session failed; refusing silent CPU fallback: ' + str(actual))
                logging.info('Verified active ONNX session providers: %s', actual)
        ort.InferenceSession = VerifiedSession
        from audio_separator.separator import Separator
        class AtomicSeparator(Separator):
            def download_file_if_not_exists(self, url, output_path):
                if os.path.isfile(output_path):
                    return
                # Upstream writes directly to the final filename. Keep incomplete
                # downloads separate so retries never accept a truncated model.
                import requests
                temp = output_path + '.download-partial'
                with requests.get(url, stream=True, timeout=(30, 120)) as response:
                    response.raise_for_status()
                    count = 0
                    md5 = hashlib.md5()
                    with open(temp, 'wb') as output:
                        for chunk in response.iter_content(chunk_size=1024*1024):
                            if chunk:
                                output.write(chunk)
                                count += len(chunk)
                                md5.update(chunk)
                    expected = int(response.headers.get('content-length', 0))
                    # requests transparently decompresses raw GitHub JSON;
                    # Content-Length then describes compressed network bytes.
                    encoded = response.headers.get('content-encoding', 'identity') != 'identity'
                    if count == 0 or (expected and not encoded and count != expected):
                        raise RuntimeError('Incomplete model download: ' + url)
                    expected_md5 = response.headers.get('x-ms-blob-content-md5')
                    if expected_md5:
                        import base64
                        if base64.b64encode(md5.digest()).decode() != expected_md5:
                            raise RuntimeError('Model checksum mismatch')
                os.replace(temp, output_path)
        separator = AtomicSeparator(model_file_dir=args.models, output_dir=args.output,
                              output_format='WAV', log_level=logging.INFO,
                              use_soundfile=True,
                              mdx_params={'segment_size': 256, 'overlap': 0.25,
                                          'batch_size': 1, 'hop_length': 1024,
                                          'enable_denoise': False})
        separator.load_model(model_filename=args.model)
        if not args.prepare:
            separator.separate(args.input, {'Vocals': 'vocal', 'Instrumental': 'backing'})
            for stem in ('vocal', 'backing'):
                file = Path(args.output) / (stem + '.wav')
                if not file.is_file() or file.stat().st_size < 128:
                    raise RuntimeError('Missing separated stem: ' + stem)
    print(json.dumps({'ok': True, 'model': args.model, 'providers': sorted(set(providers)),
                      'torchDevice': str(separator.torch_device)}), flush=True)
except Exception as exc:
    import traceback
    traceback.print_exc(file=sys.stderr)
    print(json.dumps({'ok': False, 'error': str(exc)}), flush=True)
    sys.exit(1)
