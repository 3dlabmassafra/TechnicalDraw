import os
import gradio as gr
from fastapi import FastAPI
from fastapi.responses import HTMLResponse

# Imposta OpenGL prima di importare pyrender
os.environ.setdefault("PYOPENGL_PLATFORM", "osmesa")

# Importa la tua app FastAPI (che contiene gli endpoint /api/generate ecc.)
from backend.main import app as fastapi_app

# Aggiungi una home page
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
        <p>Backend attivo su Hugging Face Spaces.</p>
        <ul>
          <li><a href="/docs">API Documentation (/docs)</a></li>
          <li><a href="/ui">Gradio UI (/ui)</a></li>
        </ul>
      </body>
    </html>
    """

# Crea una semplice UI Gradio
with gr.Blocks(title="TechnicalDraw") as demo:
    gr.Markdown("""
    # TechnicalDraw API
    
    Backend per generare tavole tecniche A4 da modelli 3D.
    
    ## API Endpoints:
    - `/docs` - Documentazione Swagger
    - `/api/generate` - Genera tavola A4
    - `/api/prep-image` - Prepara immagine per ragnar.build
    """)
    
    gr.HTML("""
    <p>Per usare l'API, punta il tuo frontend a questo URL:</p>
    <code style="background:#f0f0f0; padding:10px; display:block;">
    https://3dlab-technicaldraw-api.hf.space
    </code>
    """)

# Integra FastAPI con Gradio
app = gr.mount_gradio_app(fastapi_app, demo, path="/ui")

# Punto di ingresso per Hugging Face Spaces
if __name__ == "__main__":
    port = int(os.environ.get("PORT", "7860"))
    # Lanciamo l'app combinata (FastAPI + Gradio)
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=port)