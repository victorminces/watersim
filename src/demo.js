// A stand-in silhouette for working on the water without a camera: a figure
// that walks across the frame and swings its arms. White = body, black = water.

export class DemoMask {
  constructor(w = 320, h = 180) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: false });
    this.generation = 0;
  }

  resize(aspect) {
    const w = 320;
    const h = Math.max(90, Math.round(w / Math.max(aspect, 0.1)));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  update(t) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const u = Math.min(W, H) / 180; // unit scale

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    const cx = W * (0.5 + 0.28 * Math.sin(t * 0.33));
    const cy = H * (0.56 + 0.05 * Math.sin(t * 0.9));
    const swing = Math.sin(t * 2.1);

    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // head
    ctx.beginPath();
    ctx.arc(cx, cy - 34 * u, 11 * u, 0, Math.PI * 2);
    ctx.fill();

    // torso
    ctx.lineWidth = 22 * u;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 22 * u);
    ctx.lineTo(cx, cy + 14 * u);
    ctx.stroke();

    // arms
    ctx.lineWidth = 9 * u;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 16 * u);
    ctx.lineTo(cx - 26 * u, cy - 16 * u + 20 * u * swing);
    ctx.moveTo(cx, cy - 16 * u);
    ctx.lineTo(cx + 26 * u, cy - 16 * u - 20 * u * swing);
    ctx.stroke();

    // legs
    ctx.lineWidth = 11 * u;
    ctx.beginPath();
    ctx.moveTo(cx, cy + 12 * u);
    ctx.lineTo(cx - 13 * u + 7 * u * swing, cy + 44 * u);
    ctx.moveTo(cx, cy + 12 * u);
    ctx.lineTo(cx + 13 * u + 7 * u * swing, cy + 44 * u);
    ctx.stroke();

    this.generation++;
  }
}
