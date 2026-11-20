// Thin WebGL2 helpers: context, programs, float render targets, ping-pong
// buffers and a full-screen quad. No state beyond what each object owns.

export function createGL(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    desynchronized: true,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('This browser has no WebGL2.');
  if (!gl.getExtension('EXT_color_buffer_float') &&
      !gl.getExtension('EXT_color_buffer_half_float')) {
    throw new Error('This GPU cannot render to float textures.');
  }
  gl.getExtension('OES_texture_float_linear');
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  return gl;
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('Shader failed to compile:\n' + log);
  }
  return sh;
}

export class Program {
  constructor(gl, vertSrc, fragSrc) {
    this.gl = gl;
    const vs = compile(gl, gl.VERTEX_SHADER, vertSrc);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('Program failed to link:\n' + gl.getProgramInfoLog(p));
    }
    this.prog = p;
    this.locs = new Map();
    this.unit = 0;
  }

  loc(name) {
    if (!this.locs.has(name)) {
      this.locs.set(name, this.gl.getUniformLocation(this.prog, name));
    }
    return this.locs.get(name);
  }

  use() {
    this.gl.useProgram(this.prog);
    this.unit = 0;
    return this;
  }

  f(name, v) { this.gl.uniform1f(this.loc(name), v); return this; }
  i(name, v) { this.gl.uniform1i(this.loc(name), v | 0); return this; }
  v2(name, x, y) { this.gl.uniform2f(this.loc(name), x, y); return this; }
  v3(name, a) { this.gl.uniform3f(this.loc(name), a[0], a[1], a[2]); return this; }
  v4(name, a) { this.gl.uniform4f(this.loc(name), a[0], a[1], a[2], a[3]); return this; }
  v4a(name, arr) { this.gl.uniform4fv(this.loc(name), arr); return this; }

  tex(name, texture) {
    const gl = this.gl;
    const unit = this.unit++;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.loc(name), unit);
    return this;
  }
}

export function makeTexture(gl, filter = gl.LINEAR) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

export function makeTarget(gl, w, h) {
  const tex = makeTexture(gl);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error('Could not create a float render target.');
  }
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fbo, w, h };
}

export class PingPong {
  constructor(gl, w, h) {
    this.gl = gl;
    this.w = w;
    this.h = h;
    this.pair = [makeTarget(gl, w, h), makeTarget(gl, w, h)];
    this.i = 0;
  }
  get read() { return this.pair[this.i]; }
  get write() { return this.pair[1 - this.i]; }
  swap() { this.i = 1 - this.i; }
  clear() {
    const gl = this.gl;
    for (const t of this.pair) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  dispose() {
    const gl = this.gl;
    for (const t of this.pair) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }
  }
}

export function fullscreenQuad(gl) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return {
    draw() {
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}

// Binds a render target (or the canvas when target is null) and sets the viewport.
export function bindTarget(gl, target, w, h) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
  gl.viewport(0, 0, target ? target.w : w, target ? target.h : h);
}

// Reads a small float render target back without stalling the frame: the copy
// goes into a pixel buffer, a fence marks it, and the data is collected on a
// later frame once the GPU has actually got there.
export class Readback {
  constructor(gl, w, h) {
    this.gl = gl;
    this.w = w;
    this.h = h;
    this.out = new Float32Array(w * h * 4);
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buf);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, this.out.byteLength, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.sync = null;
  }

  get pending() { return this.sync !== null; }

  request(target) {
    const gl = this.gl;
    if (this.sync) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buf);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
  }

  // True when fresh data has landed in this.out.
  poll() {
    const gl = this.gl;
    if (!this.sync) return false;
    const status = gl.clientWaitSync(this.sync, 0, 0);
    if (status === gl.TIMEOUT_EXPIRED) return false;
    gl.deleteSync(this.sync);
    this.sync = null;
    if (status === gl.WAIT_FAILED) return false;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buf);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.out);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return true;
  }
}
