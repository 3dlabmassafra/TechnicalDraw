import os
os.environ.setdefault("PYOPENGL_PLATFORM", os.getenv("PYOPENGL_PLATFORM", "osmesa"))

import math
import tempfile
from datetime import date
from html import escape as xml_escape

import numpy as np
import cv2
import trimesh

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def _pick_standard_scale(s_fit: float) -> float:
    standards = [0.1, 0.2, 0.25, 0.5, 1.0, 2.0, 5.0]
    candidates = [s for s in standards if s <= s_fit + 1e-9]
    return max(candidates) if candidates else min(standards)

def _format_scale(s: float) -> str:
    if abs(s - 1.0) < 1e-9:
        return "1:1"
    if s < 1.0:
        return f"1:{(1.0/s):.2g}"
    return f"{s:.2g}:1"

def _load_mesh_any(path: str) -> trimesh.Trimesh:
    # texture e materiali non servono per la tavola: li saltiamo (file molto piu' leggeri in memoria)
    loaded = trimesh.load(path, force="scene", skip_materials=True, skip_texture=True)
    if isinstance(loaded, trimesh.Scene):
        dumped = loaded.dump(concatenate=True)
        if isinstance(dumped, list):
            if not dumped:
                raise RuntimeError("GLB vuoto.")
            mesh = trimesh.util.concatenate(dumped)
        else:
            mesh = dumped
    else:
        mesh = loaded

    if not isinstance(mesh, trimesh.Trimesh):
        raise RuntimeError("Mesh non valida.")

    mesh.remove_duplicate_faces()
    mesh.remove_degenerate_faces()
    mesh.remove_unreferenced_vertices()
    mesh.process(validate=True)
    mesh.apply_translation(-mesh.bounding_box.centroid)
    return mesh

def _align_mesh_pca(mesh: trimesh.Trimesh) -> np.ndarray:
    V = mesh.vertices.view(np.ndarray).astype(np.float64)
    Vc = V - V.mean(axis=0, keepdims=True)
    C = (Vc.T @ Vc) / max(len(Vc) - 1, 1)
    w, Q = np.linalg.eigh(C)
    idx = np.argsort(w)[::-1]
    Q = Q[:, idx]
    if np.linalg.det(Q) < 0:
        Q[:, 2] *= -1
    T = np.eye(4)
    T[:3, :3] = Q.T
    return T

def _transform_point(T: np.ndarray, p):
    v = np.array([p[0], p[1], p[2], 1.0], dtype=np.float64)
    return (T @ v)[:3]

def _view_rotation(view: str) -> np.ndarray:
    if view == "top":
        return np.eye(4)
    if view == "front":
        R = np.eye(4)
        R[:3, :3] = np.array([[1, 0, 0],[0, 0, 1],[0,-1, 0]], dtype=np.float64)
        return R
    if view == "right":
        R = np.eye(4)
        R[:3, :3] = np.array([[0, 1, 0],[0, 0, 1],[1, 0, 0]], dtype=np.float64)
        return R
    raise ValueError("view must be top|front|right")

def _render_ortho_numpy(mesh: trimesh.Trimesh, W: int, H: int, view: str):
    """Renderer di riserva senza OpenGL (solo CPU, numpy).

    Campiona la superficie in proporzione all'area proiettata sulla vista,
    fa lo z-buffer per pixel (vince il punto piu' vicino alla camera) e disegna
    in nero le discontinuita' di profondita', le variazioni di normale e la
    silhouette: il risultato e' un disegno a linee, come in una tavola tecnica.
    Restituisce lo stesso formato di _render_ortho_pyrender.
    """
    m = mesh.copy()
    m.apply_transform(_view_rotation(view))

    bounds = m.bounds
    extent = bounds[1] - bounds[0]
    margin = 1.15
    xmag = max(extent[0], 1e-6) * 0.5 * margin
    ymag = max(extent[1], 1e-6) * 0.5 * margin
    dist = max(extent) * 2.5 + 1e-3

    # campioni per pixel: ~4 sulle facce visibili (proiettate sulla vista, asse z)
    pixel_area = (2.0 * xmag / (W - 1)) * (2.0 * ymag / (H - 1))
    # solo facce rivolte verso la camera: quelle posteriori sono nascoste in una mesh chiusa
    nz = np.asarray(m.face_normals)[:, 2]
    proj = np.asarray(m.area_faces) * np.clip(nz, 0.0, None)
    counts = np.ceil(proj / pixel_area * 4.0).astype(np.int64)
    max_total = 2_500_000
    total = int(counts.sum())
    if total > max_total:
        counts = np.ceil(counts * (max_total / total)).astype(np.int64)
    fidx = np.repeat(np.arange(len(counts)), counts)
    if len(fidx) == 0:
        raise ValueError("Nessuna faccia visibile da questa vista.")

    # punti uniformi sul triangolo (coordinate baricentriche)
    r1 = np.random.rand(len(fidx))
    r2 = np.random.rand(len(fidx))
    s = np.sqrt(r1)
    tri = np.asarray(m.triangles)[fidx]
    pts = ((1.0 - s)[:, None] * tri[:, 0]
           + (s * (1.0 - r2))[:, None] * tri[:, 1]
           + (s * r2)[:, None] * tri[:, 2])
    nrm = np.asarray(m.face_normals)[fidx]

    ui = np.rint((pts[:, 0] / xmag + 1.0) / 2.0 * (W - 1)).astype(np.int64)
    vi = np.rint((1.0 - pts[:, 1] / ymag) / 2.0 * (H - 1)).astype(np.int64)
    ok = (ui >= 0) & (ui < W) & (vi >= 0) & (vi < H)
    ui, vi, z, nrm = ui[ok], vi[ok], pts[ok, 2], nrm[ok]

    # z-buffer: per ogni pixel resta il punto piu' vicino alla camera (z massima)
    key = vi * W + ui
    order = np.lexsort((z, key))
    ks = key[order]
    last = np.r_[ks[1:] != ks[:-1], True]
    sel = order[last]

    cover_flat = np.zeros(H * W, dtype=bool)
    cover_flat[key[sel]] = True
    depth_flat = np.full(H * W, -1e9)
    depth_flat[key[sel]] = z[sel]
    normal_flat = np.zeros((H * W, 3))
    normal_flat[key[sel]] = nrm[sel]
    cover = cover_flat.reshape(H, W)
    depth = depth_flat.reshape(H, W).astype(np.float32)
    normal = normal_flat.reshape(H, W, 3)

    # riempi i buchi interni (pochi pixel senza campione): chiusura morfologica
    # e profondita' massima dei vicini (la superficie visibile e' quella piu' alta)
    k3 = np.ones((3, 3), np.uint8)
    closed = cv2.morphologyEx(cover.astype(np.uint8), cv2.MORPH_CLOSE, k3) > 0
    neigh_max = cv2.dilate(depth, k3)
    depth = np.where(cover, depth, np.where(closed, neigh_max, -1e9)).astype(np.float32)
    cover = closed

    # un pixel con un vicino piu' alto non puo' essere la superficie visibile: se un
    # campione posteriore (es. parete interna di un foro) ha vinto per mancanza di
    # campioni della faccia davanti, prende la profondita' massima del vicinato
    depth_masked = np.where(cover, depth, -1e9).astype(np.float32)
    dmax = cv2.dilate(depth_masked, k3)
    replace = cover & (dmax > depth + 1e-6)
    depth = np.where(replace, dmax, depth).astype(np.float32)
    normal[replace] = 0.0
    has_n = np.linalg.norm(normal, axis=2) > 0.5  # pixel con normale reale

    depth_tol = max(extent) * 0.003   # salto di profondita' significativo
    cos_tol = 0.95                    # ~18 gradi di variazione di normale
    edge = np.zeros((H, W), dtype=bool)
    for dy, dx in [(0, 1), (1, 0)]:
        a = cover[:H - dy, :W - dx]
        b = cover[dy:, dx:]
        both = a & b
        da, db = depth[:H - dy, :W - dx], depth[dy:, dx:]
        na, nb = normal[:H - dy, :W - dx], normal[dy:, dx:]
        nboth = has_n[:H - dy, :W - dx] & has_n[dy:, dx:]

        jump = np.zeros_like(both)
        jump[both] = np.abs(da[both] - db[both]) > depth_tol
        bend = np.zeros_like(both)
        pair = both & nboth
        bend[pair] = np.einsum("ij,ij->i", na[pair], nb[pair]) < cos_tol
        e = jump | bend
        edge[:H - dy, :W - dx] |= e
        edge[dy:, dx:] |= e

        sil = a ^ b  # bordo tra pezzo e sfondo
        edge[:H - dy, :W - dx] |= sil & a
        edge[dy:, dx:] |= sil & b

    edge = cv2.dilate(edge.astype(np.uint8), np.ones((2, 2), np.uint8)) > 0
    img = np.full((H, W, 3), 255, dtype=np.uint8)
    img[edge] = 0
    rgba = np.dstack([img, np.full((H, W), 255, dtype=np.uint8)])
    depth_out = np.where(cover, dist - depth, 0.0).astype(np.float32)
    return {"color": rgba, "depth": depth_out, "xmag": xmag, "ymag": ymag, "dist": dist, "W": W, "H": H,
            "holes_ok": False}  # Hough su disegni a linee produce troppi falsi cerchi


def _render_ortho(mesh: trimesh.Trimesh, W: int, H: int, view: str):
    # pyrender carica OpenGL/OSMesa: se non disponibile usa il renderer numpy
    try:
        import pyrender  # noqa: F401
    except (ImportError, OSError):
        return _render_ortho_numpy(mesh, W, H, view)
    return _render_ortho_pyrender(mesh, W, H, view)


def _render_ortho_pyrender(mesh: trimesh.Trimesh, W: int, H: int, view: str):
    import pyrender

    m = mesh.copy()
    m.apply_transform(_view_rotation(view))

    bounds = m.bounds
    extent = (bounds[1] - bounds[0])
    margin = 1.15
    xmag = max(extent[0], 1e-6) * 0.5 * margin
    ymag = max(extent[1], 1e-6) * 0.5 * margin
    dist = max(extent) * 2.5 + 1e-3

    scene = pyrender.Scene(bg_color=[255, 255, 255, 255], ambient_light=[1.0, 1.0, 1.0])
    scene.add(pyrender.Mesh.from_trimesh(m, smooth=False))
    scene.add(pyrender.DirectionalLight(color=np.ones(3), intensity=2.5), pose=np.eye(4))

    cam = pyrender.OrthographicCamera(xmag=xmag, ymag=ymag, znear=0.01, zfar=dist * 5)
    cam_pose = np.eye(4)
    cam_pose[2, 3] = dist
    scene.add(cam, pose=cam_pose)

    r = pyrender.OffscreenRenderer(viewport_width=W, viewport_height=H)
    color, depth = r.render(scene)
    r.delete()
    return {"color": color, "depth": depth, "xmag": xmag, "ymag": ymag, "dist": dist, "W": W, "H": H}

def _pixel_to_world_xy(u, v, info):
    W, H = info["W"], info["H"]
    xmag, ymag = info["xmag"], info["ymag"]
    x = ((u / (W - 1)) * 2.0 - 1.0) * xmag
    y = (1.0 - (v / (H - 1)) * 2.0) * ymag
    return np.array([x, y], dtype=np.float64)

def _edges_to_svg_paths(color_rgba, mm_per_unit: float, info, simplify=2.0):
    img = color_rgba[..., :3].copy()
    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)

    edges = cv2.Canny(gray, 50, 140)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)

    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)  # RETR_LIST: include anche i fori (contorni interni)

    paths, all_pts = [], []
    for c in contours:
        if cv2.contourArea(c) < 50:
            continue
        approx = cv2.approxPolyDP(c, epsilon=simplify, closed=True)
        pts = approx.reshape(-1, 2)

        pts_mm = []
        for (u, v) in pts:
            xy = _pixel_to_world_xy(u, v, info)
            pts_mm.append([xy[0] * mm_per_unit, -xy[1] * mm_per_unit])
        pts_mm = np.array(pts_mm, dtype=np.float64)
        all_pts.append(pts_mm)

        d = []
        for i, (x, y) in enumerate(pts_mm):
            d.append(("M" if i == 0 else "L") + f" {x:.3f} {y:.3f}")
        d.append("Z")
        paths.append(" ".join(d))

    if all_pts:
        P = np.vstack(all_pts)
        bbox = (float(P[:, 0].min()), float(P[:, 1].min()), float(P[:, 0].max()), float(P[:, 1].max()))
    else:
        bbox = (-10.0, -10.0, 10.0, 10.0)
    return paths, bbox

def detect_holes_hough(color_rgba, info, mm_per_unit: float):
    gray = cv2.cvtColor(color_rgba[..., :3], cv2.COLOR_RGB2GRAY)
    gray = cv2.GaussianBlur(gray, (7, 7), 1.5)

    circles = cv2.HoughCircles(
        gray, cv2.HOUGH_GRADIENT,
        dp=1.2, minDist=25,
        param1=120, param2=30,
        minRadius=6, maxRadius=0
    )
    if circles is None:
        return []

    W = info["W"]
    xmag = info["xmag"]
    world_per_px = (2.0 * xmag) / max(W - 1, 1)

    out = []
    circles = np.round(circles[0]).astype(int)[:10]
    for (u, v, r_px) in circles:
        xy = _pixel_to_world_xy(u, v, info)
        x_mm = float(xy[0] * mm_per_unit)
        y_mm = float(-xy[1] * mm_per_unit)
        diam_mm = float(2.0 * r_px * world_per_px * mm_per_unit)
        if 1.0 <= diam_mm <= 5000.0:
            out.append({"x": x_mm, "y": y_mm, "diam": diam_mm})
    return out

def _svg_dim_line(x1, y1, x2, y2, label, offset=6.0):
    dx, dy = (x2 - x1), (y2 - y1)
    L = math.hypot(dx, dy) or 1.0
    ux, uy = dx / L, dy / L
    nx, ny = -uy, ux
    ex, ey = nx * offset, ny * offset

    qx1, qy1 = x1 + ex, y1 + ey
    qx2, qy2 = x2 + ex, y2 + ey
    mx, my = (qx1 + qx2) / 2, (qy1 + qy2) / 2

    return f"""
      <line x1="{x1:.3f}" y1="{y1:.3f}" x2="{qx1:.3f}" y2="{qy1:.3f}" stroke="#000" stroke-width="0.25"/>
      <line x1="{x2:.3f}" y1="{y2:.3f}" x2="{qx2:.3f}" y2="{qy2:.3f}" stroke="#000" stroke-width="0.25"/>
      <line x1="{qx1:.3f}" y1="{qy1:.3f}" x2="{qx2:.3f}" y2="{qy2:.3f}"
            stroke="#000" stroke-width="0.25" marker-start="url(#arrow)" marker-end="url(#arrow)"/>
      <rect x="{mx - 18:.3f}" y="{my - 4.5:.3f}" width="36" height="9" fill="#fff" opacity="0.9"/>
      <text x="{mx:.3f}" y="{my + 2.5:.3f}" font-size="5" text-anchor="middle" font-family="Arial">{label}</text>
    """

def _make_a4_three_views_svg(views, title: str, scale_s: float, dims_mm):
    pageW, pageH = 297.0, 210.0
    margin, tbH = 10.0, 35.0
    areaX, areaY = margin, margin
    areaW = pageW - 2 * margin
    areaH = pageH - 2 * margin - tbH

    top_vp   = (areaX, areaY,              areaW * 0.62, areaH * 0.48)
    front_vp = (areaX, areaY + areaH*0.52, areaW * 0.62, areaH * 0.48)
    right_vp = (areaX + areaW*0.66, areaY + areaH*0.52, areaW * 0.34, areaH * 0.48)
    vps = {"top": top_vp, "front": front_vp, "right": right_vp}

    def compute_placement(k):
        vpX, vpY, vpW, vpH = vps[k]
        minx, miny, maxx, maxy = views[k]["bbox"]
        vw = max(maxx - minx, 1e-6)
        vh = max(maxy - miny, 1e-6)
        drawW, drawH = vw * scale_s, vh * scale_s
        Tx = vpX + (vpW - drawW) / 2.0
        Ty = vpY + (vpH - drawH) / 2.0
        return Tx, Ty, minx, miny

    def map_view(k, x, y):
        Tx, Ty, minx, miny = compute_placement(k)
        X = Tx + (x - minx) * scale_s
        Y = Ty + (y - miny) * scale_s
        return X, Y

    def place_view(k):
        vpX, vpY, vpW, vpH = vps[k]
        Tx, Ty, minx, miny = compute_placement(k)
        tr = f"translate({Tx:.3f},{Ty:.3f}) scale({scale_s:.6f}) translate({-minx:.3f},{-miny:.3f})"
        elems = [f'<g transform="{tr}">']
        for d in views[k]["paths"]:
            elems.append(f'<path d="{d}" stroke="#000" stroke-width="0.30" vector-effect="non-scaling-stroke" fill="none"/>')
        elems.append("</g>")
        elems.append(f'<rect x="{vpX:.3f}" y="{vpY:.3f}" width="{vpW:.3f}" height="{vpH:.3f}" fill="none" stroke="#000" stroke-width="0.20"/>')
        elems.append(f'<text x="{(vpX + 3):.3f}" y="{(vpY + 7):.3f}" font-size="5" font-family="Arial">{k.upper()}</text>')
        return "\n".join(elems)

    Lmm, Pmm, Hmm = dims_mm
    dims_elems = []

    fminx, fminy, fmaxx, fmaxy = views["front"]["bbox"]
    x1, y1 = map_view("front", fminx, fmaxy)
    x2, y2 = map_view("front", fmaxx, fmaxy)
    dims_elems.append(_svg_dim_line(x1, y1, x2, y2, f"{Lmm:.2f} mm", offset=7.0))
    x1, y1 = map_view("front", fminx, fminy)
    x2, y2 = map_view("front", fminx, fmaxy)
    dims_elems.append(_svg_dim_line(x1, y1, x2, y2, f"{Hmm:.2f} mm", offset=7.0))

    tminx, tminy, tmaxx, tmaxy = views["top"]["bbox"]
    x1, y1 = map_view("top", tminx, tminy)
    x2, y2 = map_view("top", tminx, tmaxy)
    dims_elems.append(_svg_dim_line(x1, y1, x2, y2, f"{Pmm:.2f} mm", offset=7.0))

    hole_elems = []
    for k in ["front", "top", "right"]:
        for h in views[k].get("holes", []):
            X, Y = map_view(k, h["x"], h["y"])
            hole_elems.append(f'<text x="{X + 3:.3f}" y="{Y - 3:.3f}" font-size="4.5" font-family="Arial">Ø {h["diam"]:.2f}</text>')
            hole_elems.append(f'<circle cx="{X:.3f}" cy="{Y:.3f}" r="1.2" fill="none" stroke="#000" stroke-width="0.25"/>')

    arrow_def = """
    <defs>
      <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6 Z" fill="#000"/>
      </marker>
    </defs>
    """

    tbX = margin
    tbY = pageH - margin - tbH
    tbW = pageW - 2 * margin
    v1 = tbX + tbW * 0.62
    v2 = tbX + tbW * 0.78
    h1 = tbY + tbH * 0.50

    today = date.today().isoformat()
    scale_label = _format_scale(scale_s)

    title_block = f"""
      <rect x="{tbX:.3f}" y="{tbY:.3f}" width="{tbW:.3f}" height="{tbH:.3f}" fill="none" stroke="#000" stroke-width="0.35"/>
      <line x1="{v1:.3f}" y1="{tbY:.3f}" x2="{v1:.3f}" y2="{tbY+tbH:.3f}" stroke="#000" stroke-width="0.25"/>
      <line x1="{v2:.3f}" y1="{tbY:.3f}" x2="{v2:.3f}" y2="{tbY+tbH:.3f}" stroke="#000" stroke-width="0.25"/>
      <line x1="{tbX:.3f}" y1="{h1:.3f}" x2="{tbX+tbW:.3f}" y2="{h1:.3f}" stroke="#000" stroke-width="0.25"/>

      <text x="{tbX+3:.3f}" y="{tbY+12:.3f}" font-size="6" font-family="Arial">Titolo: {xml_escape(title)}</text>
      <text x="{v1+3:.3f}" y="{tbY+12:.3f}" font-size="6" font-family="Arial">Scala: {scale_label}</text>
      <text x="{v2+3:.3f}" y="{tbY+12:.3f}" font-size="6" font-family="Arial">Data: {today}</text>

      <text x="{tbX+3:.3f}" y="{tbY+22:.3f}" font-size="5" font-family="Arial">
        Ingombri (mm): L={Lmm:.2f}  P={Pmm:.2f}  H={Hmm:.2f}
      </text>
    """

    frame = f'<rect x="{margin:.3f}" y="{margin:.3f}" width="{(pageW - 2*margin):.3f}" height="{(pageH - 2*margin):.3f}" fill="none" stroke="#000" stroke-width="0.35"/>'

    svg = f"""<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     width="{pageW:.2f}mm" height="{pageH:.2f}mm"
     viewBox="0 0 {pageW:.3f} {pageH:.3f}">
  {arrow_def}
  <rect x="0" y="0" width="{pageW:.3f}" height="{pageH:.3f}" fill="#fff"/>
  {frame}
  {place_view("top")}
  {place_view("front")}
  {place_view("right")}
  {''.join(dims_elems)}
  {''.join(hole_elems)}
  {title_block}
</svg>
"""
    return svg

def _svg_to_raster_or_pdf(svg: str, fmt: str) -> bytes:
    """SVG -> PDF o PNG. Usa cairosvg (Docker, con libcairo) oppure, se non disponibile,
    svglib + reportlab (PDF) e pypdfium2 (PNG), che non richiedono librerie di sistema."""
    try:
        import cairosvg
        if fmt == "png":
            return cairosvg.svg2png(bytestring=svg.encode("utf-8"), dpi=300)
        return cairosvg.svg2pdf(bytestring=svg.encode("utf-8"))
    except (ImportError, OSError):
        pass

    try:
        import io
        from svglib.svglib import svg2rlg
        from reportlab.graphics import renderPDF
    except ImportError as e:
        raise HTTPException(503, f"Conversione PDF non disponibile su questo server: {e}")

    pdf = renderPDF.drawToString(svg2rlg(io.BytesIO(svg.encode("utf-8"))))
    if fmt == "pdf":
        return pdf
    try:
        import pypdfium2 as pdfium
    except ImportError as e:
        raise HTTPException(503, f"Conversione PNG non disponibile su questo server: {e}")
    import io as _io
    doc = pdfium.PdfDocument(pdf)
    img = doc[0].render(scale=300 / 72).to_pil()
    buf = _io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@app.post("/api/generate")
async def generate(
    model_file: UploadFile = File(...),
    p1x: float = Form(...), p1y: float = Form(...), p1z: float = Form(...),
    p2x: float = Form(...), p2y: float = Form(...), p2z: float = Form(...),
    real_mm: float = Form(...),
    out_format: str = Form("pdf"),
    title: str = Form("Disegno CAD"),
):
    if real_mm <= 0:
        raise HTTPException(400, "real_mm deve essere > 0")

    mb = await model_file.read()
    if len(mb) > 300_000_000:
        raise HTTPException(413, "GLB troppo grande (max ~300MB)")

    with tempfile.TemporaryDirectory() as td:
        glb_path = td + "/model.glb"
        with open(glb_path, "wb") as f:
            f.write(mb)
        mesh = _load_mesh_any(glb_path)

    T = _align_mesh_pca(mesh)
    mesh.apply_transform(T)

    P1 = _transform_point(T, (p1x, p1y, p1z))
    P2 = _transform_point(T, (p2x, p2y, p2z))
    dist_units = float(np.linalg.norm(P2 - P1))
    if dist_units < 1e-9:
        raise HTTPException(400, "Punti troppo vicini.")

    mm_per_unit = float(real_mm / dist_units)

    ext = (mesh.bounds[1] - mesh.bounds[0])
    dims_mm = (float(ext[0] * mm_per_unit), float(ext[1] * mm_per_unit), float(ext[2] * mm_per_unit))

    Wv, Hv = 900, 650
    views = {}
    for k in ["top", "front", "right"]:
        rinfo = _render_ortho(mesh, Wv, Hv, k)
        paths, bbox = _edges_to_svg_paths(rinfo["color"], mm_per_unit, rinfo, simplify=2.0)
        holes = detect_holes_hough(rinfo["color"], rinfo, mm_per_unit) if rinfo.get("holes_ok", True) else []
        views[k] = {"paths": paths, "bbox": bbox, "holes": holes}

    pageW, pageH, margin, tbH = 297.0, 210.0, 10.0, 35.0
    areaW = pageW - 2 * margin
    areaH = pageH - 2 * margin - tbH
    vp = {
        "top":   (areaW * 0.62, areaH * 0.48),
        "front": (areaW * 0.62, areaH * 0.48),
        "right": (areaW * 0.34, areaH * 0.48),
    }

    s_fit_all = 1e9
    for k in ["top", "front", "right"]:
        minx, miny, maxx, maxy = views[k]["bbox"]
        vw = max(maxx - minx, 1e-6)
        vh = max(maxy - miny, 1e-6)
        vpW, vpH = vp[k]
        s_fit_all = min(s_fit_all, min((vpW * 0.90) / vw, (vpH * 0.90) / vh))

    scale_s = _pick_standard_scale(s_fit_all)
    svg = _make_a4_three_views_svg(views, title, scale_s, dims_mm)

    out_format = out_format.lower().strip()
    if out_format == "svg":
        return Response(svg, media_type="image/svg+xml")
    if out_format == "png":
        return Response(_svg_to_raster_or_pdf(svg, "png"), media_type="image/png")
    if out_format == "pdf":
        return Response(_svg_to_raster_or_pdf(svg, "pdf"), media_type="application/pdf")

    raise HTTPException(400, "Formato non supportato: usa png|pdf|svg")