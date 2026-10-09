import os
from pathlib import Path

# Imposta OpenGL prima di importare pyrender
os.environ.setdefault("PYOPENGL_PLATFORM", "osmesa")

import gradio as gr
import uvicorn
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles


class NoCacheStaticFiles(StaticFiles):
    """File statici che il browser deve riconvalidare ad ogni caricamento (niente pagina vecchia in cache)."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response

# Importa la tua app FastAPI (che contiene gli endpoint /api/generate ecc.)
from backend.main import app as fastapi_app

FRONTEND_DIR = Path(__file__).resolve().parent / "frontend"

# Frontend web servito dallo stesso server dell'API (es. http://host:7860/app/)
fastapi_app.mount("/app", NoCacheStaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")


# Home page dell'API
@fastapi_app.get("/", response_class=HTMLResponse)
def home():
    return """
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>TechnicalDraw API</title>
      </head>
      <body style="font-family: Arial; padding: 30px;">
        <h1>TechnicalDraw API</h1>
        <p>Backend attivo.</p>
        <ul>
          <li><a href="/app/">Applicazione web (/app)</a></li>
          <li><a href="/docs">API Documentation (/docs)</a></li>
          <li><a href="/ui">Gradio UI (/ui)</a></li>
        </ul>
      </body>
    </html>
    """


# Semplice UI Gradio
with gr.Blocks(title="TechnicalDraw") as demo:
    gr.Markdown("""
    # TechnicalDraw API

    Backend per generare tavole tecniche A4 da modelli 3D.

    ## API Endpoints:
    - `/app` - Applicazione web
    - `/docs` - Documentazione Swagger
    - `/api/generate` - Genera tavola A4
    """)

# Integra Gradio nell'app FastAPI (le API restano su /api/*)
app = gr.mount_gradio_app(fastapi_app, demo, path="/ui", css="footer {visibility: hidden}")

# Punto di ingresso locale / Hugging Face Spaces
if __name__ == "__main__":
    port = int(os.environ.get("PORT", "7860"))
    uvicorn.run(app, host="0.0.0.0", port=port)
