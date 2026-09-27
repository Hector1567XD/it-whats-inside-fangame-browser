// 📸 Imágenes para descargar desde los detalles de la ronda: grafos de chats privados e hilos de Cotorra.
// Se dibujan a mano en un <canvas> (sin librerías): así el PNG sale igual en cualquier navegador.
import { avatarUri } from "./Avatar";
import type { NightEdge, PlayerView, ThreadLogPost } from "./net";

type Lookup = (id: string) => PlayerView | undefined;
const FONT = '"Nunito", system-ui, sans-serif';
const TITLE = '"Lilita One", "Nunito", sans-serif';
const INK = "#2a0d4d";

const images = new Map<string, Promise<HTMLImageElement>>();
function loadImage(src: string) {
  let p = images.get(src);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
    images.set(src, p);
  }
  return p;
}

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  const dpr = 2; // nítido en pantallas retina y al compartir
  c.width = w * dpr;
  c.height = h * dpr;
  const g = c.getContext("2d")!;
  g.scale(dpr, dpr);
  return { c, g };
}

function background(g: CanvasRenderingContext2D, w: number, h: number) {
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, "#7b2ff7");
  grad.addColorStop(1, "#d6246e");
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

async function avatar(g: CanvasRenderingContext2D, p: PlayerView | undefined, x: number, y: number, r: number) {
  g.save();
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = p?.color ?? "#999";
  g.fill();
  g.lineWidth = Math.max(2, r / 8);
  g.strokeStyle = "#fff";
  g.stroke();
  g.clip();
  try {
    const img = await loadImage(avatarUri(p?.avatar || "big-smile:x"));
    g.drawImage(img, x - r * 0.88, y - r * 0.88, r * 1.76, r * 1.76);
  } catch { /* sin avatar, queda el círculo de color */ }
  g.restore();
}

/** Parte `text` en líneas que entren en `max` px. */
function wrap(g: CanvasRenderingContext2D, text: string, max: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (g.measureText(next).width > max && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function footer(g: CanvasRenderingContext2D, w: number, h: number) {
  g.font = `800 13px ${FONT}`;
  g.fillStyle = "rgba(255,255,255,0.75)";
  g.textAlign = "right";
  g.fillText("MINDSWAP · lo que importa es lo que hay adentro", w - 20, h - 16);
  g.textAlign = "left";
}

export function download(c: HTMLCanvasElement, name: string) {
  c.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, "image/png");
}

const slugName = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * 🕸️ Grafo de una noche: los cuerpos en círculo; la línea se engrosa con los mensajes (💬) y va punteada si
 * hubo 📻 Llamadas de radio. Con `minds`, debajo de cada cuerpo sale quién estaba adentro.
 */
export async function graphImage({ title, bodies, edges, P, minds }: {
  title: string; bodies: string[]; edges: NightEdge[]; P: Lookup; minds?: Record<string, string>;
}) {
  const W = 720;
  const H = 760;
  const { c, g } = canvas(W, H);
  background(g, W, H);
  g.fillStyle = "#fff";
  g.font = `44px ${TITLE}`;
  g.fillText(title, 28, 64);
  const cx = W / 2;
  const cy = 400;
  const R = 250;
  const pos = new Map(bodies.map((id, i) => {
    const a = (i / bodies.length) * Math.PI * 2 - Math.PI / 2;
    return [id, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) }];
  }));
  const max = Math.max(1, ...edges.map((e) => e.dms + e.calls));
  for (const e of edges) {
    const a = pos.get(e.aBody);
    const b = pos.get(e.bBody);
    if (!a || !b) continue;
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.lineCap = "round";
    g.lineWidth = 3 + 12 * ((e.dms + e.calls) / max);
    g.strokeStyle = e.dms > 0 ? "rgba(255,210,61,0.85)" : "rgba(94,227,122,0.9)";
    g.setLineDash(e.dms === 0 && e.calls > 0 ? [14, 10] : []);
    g.stroke();
    g.setLineDash([]);
    // etiqueta en el medio de la línea
    const label = [e.dms && `💬 ${e.dms}`, e.calls && `📻 ${fmtSec(e.callSec)}`].filter(Boolean).join("  ");
    g.font = `800 14px ${FONT}`;
    const tw = g.measureText(label).width + 14;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    roundRect(g, mx - tw / 2, my - 13, tw, 26, 13);
    g.fillStyle = "#fff";
    g.fill();
    g.fillStyle = INK;
    g.textAlign = "center";
    g.fillText(label, mx, my + 5);
    g.textAlign = "left";
  }
  for (const id of bodies) {
    const at = pos.get(id)!;
    const p = P(id);
    const talking = edges.some((e) => e.aBody === id || e.bBody === id);
    g.globalAlpha = talking ? 1 : 0.55;
    await avatar(g, p, at.x, at.y, 38);
    g.textAlign = "center";
    g.fillStyle = "#fff";
    g.font = `800 17px ${FONT}`;
    g.fillText(p?.name ?? "?", at.x, at.y + 60);
    const mind = minds?.[id];
    if (mind) {
      g.font = `700 13px ${FONT}`;
      g.fillStyle = "rgba(255,255,255,0.85)";
      g.fillText(mind === id ? "🟢 no cambió" : `🧠 ${P(mind)?.name ?? "?"} adentro`, at.x, at.y + 78);
    }
    g.textAlign = "left";
    g.globalAlpha = 1;
  }
  if (edges.length === 0) {
    g.font = `800 22px ${FONT}`;
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.fillText("🤫 Nadie habló en privado", cx, cy);
    g.textAlign = "left";
  }
  footer(g, W, H);
  return c;
}

export const fmtSec = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s`);

/** 🦜 Un hilo de Cotorra como captura: la pregunta de La Máquina, el cotorreo y sus respuestas, con quién era de verdad. */
export async function threadImage({ question, post, P, reveal }: {
  question: string; post: ThreadLogPost; P: Lookup; reveal: boolean;
}) {
  const W = 640;
  const pad = 22;
  const textW = W - pad * 2 - 64;
  // Medir primero (en un canvas de prueba) para saber el alto.
  const probe = document.createElement("canvas").getContext("2d")!;
  probe.font = `700 18px ${FONT}`;
  const mainLines = wrap(probe, post.text, textW);
  probe.font = `700 16px ${FONT}`;
  const replyLines = post.replies.map((r) => wrap(probe, r.text, textW - 10));
  probe.font = `800 17px ${FONT}`;
  const qLines = wrap(probe, question, textW);
  const blockH = (lines: number, lh: number) => 34 + lines * lh + 30;
  let H = 90 + blockH(qLines.length, 22) + 10 + blockH(mainLines.length, 25) + 20;
  for (const l of replyLines) H += blockH(l.length, 22) + 6;
  H += 50;

  const { c, g } = canvas(W, H);
  background(g, W, H);
  g.fillStyle = "#fff";
  g.font = `34px ${TITLE}`;
  g.fillText("🦜 cotorra", pad, 52);
  g.font = `700 14px ${FONT}`;
  g.fillStyle = "rgba(255,255,255,0.8)";
  g.fillText("· la red de la fiesta", pad + 175, 50);
  let y = 76;

  const card = async (who: PlayerView | undefined, mindName: string | null, lines: string[], lh: number, font: string, meta: string, big: boolean) => {
    const h = blockH(lines.length, lh);
    roundRect(g, pad, y, W - pad * 2, h, 18);
    g.fillStyle = big ? "#fff" : "rgba(255,255,255,0.92)";
    g.fill();
    if (who) await avatar(g, who, pad + 32, y + 32, big ? 22 : 18);
    else {
      g.font = `30px ${FONT}`;
      g.fillText("🧳", pad + 14, y + 44);
    }
    const x = pad + 64;
    g.fillStyle = INK;
    g.font = `900 16px ${FONT}`;
    const name = who ? who.name : "La Máquina";
    g.fillText(name, x, y + 26);
    let nx = x + g.measureText(name).width + 8;
    if (mindName) {
      g.font = `800 13px ${FONT}`;
      const tag = mindName;
      const tw = g.measureText(tag).width + 12;
      roundRect(g, nx, y + 11, tw, 20, 10);
      g.fillStyle = "#ffd23d";
      g.fill();
      g.fillStyle = INK;
      g.fillText(tag, nx + 6, y + 26);
      nx += tw + 8;
    }
    g.font = `700 13px ${FONT}`;
    g.fillStyle = "rgba(42,13,77,0.6)";
    g.fillText(who ? `@${slugName(who.name).replace(/-/g, "")}` : "@lamaquina ✦", nx, y + 26);
    g.fillStyle = INK;
    g.font = font;
    lines.forEach((l, i) => g.fillText(l, x, y + 50 + i * lh));
    g.font = `800 13px ${FONT}`;
    g.fillStyle = "rgba(42,13,77,0.7)";
    if (meta) g.fillText(meta, x, y + h - 12);
    y += h + (big ? 20 : 6);
  };

  const mindOf = (body: string, mind: string) => (reveal ? (mind === body ? "🟢 era su dueño" : `🧠 era ${P(mind)?.name ?? "?"}`) : null);
  await card(undefined, null, qLines, 22, `800 17px ${FONT}`, "", false);
  y += 4;
  await card(P(post.body), mindOf(post.body, post.mind), mainLines, 25, `700 18px ${FONT}`, `💬 ${post.replies.length}   ❤️ ${post.likes}   🤨 ${post.sus}`, true);
  for (const [i, r] of post.replies.entries()) {
    await card(P(r.body), mindOf(r.body, r.mind), replyLines[i], 22, `700 16px ${FONT}`, `❤️ ${r.likes}   🤨 ${r.sus}`, false);
  }
  footer(g, W, H);
  return c;
}

export const fileName = (...parts: (string | number)[]) => `mindswap-${parts.map((p) => slugName(String(p))).join("-")}.png`;
