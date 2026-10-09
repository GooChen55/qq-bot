"""Resident RVC inference; JSON lines on stdout, diagnostics on stderr."""
import contextlib
import json
import os
import sys
import traceback

runtime = os.environ.get('COVER_RUNTIME_DIR') or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'runtimes', 'Applio')
os.chdir(runtime)
sys.path.insert(0, runtime)
with contextlib.redirect_stdout(sys.stderr):
    from rvc.infer.infer import VoiceConverter
    converter = VoiceConverter()
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    try:
        job = json.loads(line)
        with contextlib.redirect_stdout(sys.stderr):
            converter.convert_audio(audio_input_path=job['input'], audio_output_path=job['output'],
                model_path=job['model'], index_path=job.get('index', ''), pitch=job.get('pitch', 0),
                f0_method='rmvpe', index_rate=0.5, protect=0.33, split_audio=False,
                embedder_model='contentvec', export_format='WAV', f0_autotune=False)
        if not os.path.isfile(job['output']) or os.path.getsize(job['output']) < 128:
            raise RuntimeError('RVC did not produce valid audio')
        print(json.dumps({'id': job['id'], 'ok': True}), flush=True)
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({'id': job.get('id'), 'error': str(exc)}), flush=True)
