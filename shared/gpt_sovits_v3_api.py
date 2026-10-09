import argparse
from io import BytesIO

import soundfile as sf
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from tools.i18n.i18n import I18nAuto
from GPT_SoVITS.inference_webui import change_gpt_weights, change_sovits_weights, get_tts_wav


i18n = I18nAuto()
app = FastAPI(title="GPT-SoVITS V3 LoRA local API")


def language_name(code):
    return i18n("日文") if str(code).lower() == "ja" else i18n("中文")


@app.get("/health")
def health():
    return {"ok": True, "version": "v3-lora"}


@app.get("/set_gpt_weights")
def set_gpt_weights(weights_path: str = ""):
    try:
        if not weights_path:
            raise ValueError("gpt weight path is required")
        change_gpt_weights(gpt_path=weights_path)
        return {"message": "success"}
    except Exception as error:
        return JSONResponse(status_code=400, content={"message": "change gpt weight failed", "Exception": str(error)})


@app.get("/set_sovits_weights")
def set_sovits_weights(weights_path: str = ""):
    try:
        if not weights_path:
            raise ValueError("sovits weight path is required")
        list(change_sovits_weights(sovits_path=weights_path))
        return {"message": "success"}
    except Exception as error:
        return JSONResponse(status_code=400, content={"message": "change sovits weight failed", "Exception": str(error)})


@app.post("/tts")
async def tts(request: Request):
    try:
        body = await request.json()
        text = str(body.get("text", "")).strip()
        ref_audio = str(body.get("ref_audio_path", "")).strip()
        prompt_text = str(body.get("prompt_text", "")).strip()
        text_lang = str(body.get("text_lang", "zh")).lower()
        prompt_lang = str(body.get("prompt_lang", "ja")).lower()
        if not text or not ref_audio or not prompt_text:
            raise ValueError("text, ref_audio_path and prompt_text are required")
        results = list(get_tts_wav(
            ref_wav_path=ref_audio,
            prompt_text=prompt_text,
            prompt_language=language_name(prompt_lang),
            text=text,
            text_language=language_name(text_lang),
            how_to_cut=i18n("按标点符号切"),
            top_k=20,
            top_p=0.6,
            temperature=0.6,
            speed=float(body.get("speed_factor", 1.0)),
        ))
        if not results:
            raise RuntimeError("synthesis returned no audio")
        sample_rate, audio = results[-1]
        output = BytesIO()
        sf.write(output, audio, sample_rate, format="WAV", subtype="PCM_16")
        return Response(content=output.getvalue(), media_type="audio/wav")
    except Exception as error:
        return JSONResponse(status_code=400, content={"message": "tts failed", "Exception": str(error)})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("-a", "--bind_addr", default="127.0.0.1")
    parser.add_argument("-p", "--port", type=int, default=9880)
    args = parser.parse_args()
    uvicorn.run(app, host=args.bind_addr, port=args.port, workers=1)
