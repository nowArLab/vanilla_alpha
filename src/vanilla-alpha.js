import { LitElement, html, css } from 'lit';

class VanillaAlpha extends LitElement {
  static properties = {
    src: { type: String, reflect: true },
    autoplay: { type: Boolean, reflect: true },
    loop: { type: Boolean, reflect: true },
    muted: { type: Boolean, reflect: true },
    playsinline: { type: Boolean, reflect: true },
  };

  static styles = css`
    :host {
      display: inline-block;
      position: relative;
      width: 640px;
      height: 360px;
      background: transparent;
      overflow: hidden;
    }
    canvas, video {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
    }
    video { 
      visibility: hidden; 
    }
    .fallback {
      position: absolute; 
      inset: 0;
      display: grid; 
      place-items: center;
      color: #9aa0a6; 
      font: 500 14px system-ui, sans-serif;
      pointer-events: none;
      background: transparent;
    }
    .fallback[hidden] { 
      display: none; 
    }
  `;

  constructor() {
    super();
    this.src = '';
    this.autoplay = true;
    this.loop = true;
    this.muted = true;
    this.playsinline = true;

    this._canvas = null;
    this._video = null;
    this._gl = null;
    this._prog = null;
    this._vbo = null;
    this._tex = null;
    this._coordLoc = null;
    this._samplerLoc = null;
    this._raf = null;
    this._readyGL = false;
    this._firstFrame = false;

    this._onResize = this._onResize.bind(this);
    this._tick = this._tick.bind(this);
    this._start = this._start.bind(this);
    this._onTimeUpdate = this._onTimeUpdate.bind(this);
    this._onPlaying = this._onPlaying.bind(this);
    this._onPause = this._onPause.bind(this);
    this._onEnded = this._onEnded.bind(this);
    this._onLoadedMeta = this._onLoadedMeta.bind(this);
    this._onError = this._onError.bind(this);
  }

  render() {
    return html`
      <canvas id="c"></canvas>
      <video
        id="v"
        crossorigin="anonymous"
        preload="auto"
        ?loop=${this.loop}
        ?muted=${this.muted}
        playsinline
        src=${this.src || ''}
      ></video>

      <div class="fallback" part="fallback" ?hidden=${this._firstFrame}>
        Inicializando…
      </div>

      <slot></slot>
    `;
  }

  firstUpdated() {
    this._canvas = this.renderRoot.getElementById('c');
    this._video  = this.renderRoot.getElementById('v');

    this._video.muted = this.muted ?? true;
    if (this.playsinline) this._video.setAttribute('playsinline', '');

    this._video.addEventListener('loadedmetadata', this._onLoadedMeta);
    this._video.addEventListener('timeupdate', this._onTimeUpdate);
    this._video.addEventListener('playing', this._onPlaying);
    this._video.addEventListener('pause', this._onPause);
    this._video.addEventListener('ended', this._onEnded);
    this._video.addEventListener('error', this._onError);

    const gl = this._canvas.getContext('webgl', { 
      antialias: false, 
      preserveDrawingBuffer: false 
    });
    
    if (!gl) {
      console.error('WebGL no disponible');
      return;
    }
    
    this._gl = gl;

    const vertices = new Float32Array([
      -1, -1, 0,
       1, -1, 0,
      -1,  1, 0,
       1,  1, 0,
    ]);
    
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    this._vbo = vbo;

    const vertexShader = `
      attribute vec3 coordinates;
      varying vec2 textureCoord;
      void main(void){
        gl_Position = vec4(coordinates,1.0);
        textureCoord = (coordinates.xy + 1.0) * 0.5;
      }
    `;
    
    const fragmentShader = `
      #ifdef GL_ES
      precision highp float;
      #endif
      varying vec2 textureCoord;
      uniform sampler2D uSampler;
      void main(void){
        vec2 adjusted = vec2(textureCoord.x, 1.0 - textureCoord.y);
        vec2 colorCoord = vec2(adjusted.x, adjusted.y * 0.5);
        vec2 alphaCoord = vec2(adjusted.x, 0.5 + adjusted.y * 0.5);
        vec4 videoColor = texture2D(uSampler, colorCoord);
        float alpha = texture2D(uSampler, alphaCoord).r;
        gl_FragColor = vec4(videoColor.rgb, alpha);
      }
    `;

    const compileShader = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(log || 'Shader compile error');
      }
      
      return shader;
    };

    const program = gl.createProgram();
    gl.attachShader(program, compileShader(gl.VERTEX_SHADER, vertexShader));
    gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, fragmentShader));
    gl.linkProgram(program);
    
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(log || 'Program link error');
    }
    
    gl.useProgram(program);
    this._prog = program;

    const coordLoc = gl.getAttribLocation(program, 'coordinates');
    gl.enableVertexAttribArray(coordLoc);
    gl.vertexAttribPointer(coordLoc, 3, gl.FLOAT, false, 0, 0);
    this._coordLoc = coordLoc;

    const samplerLoc = gl.getUniformLocation(program, 'uSampler');
    this._samplerLoc = samplerLoc;

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    this._tex = texture;

    this._readyGL = true;
    this.dispatchEvent(new CustomEvent('va-ready', { 
      bubbles: true, 
      composed: true 
    }));

    window.addEventListener('resize', this._onResize);
    this._onResize();

    if (this.autoplay) this._start();
  }

  disconnectedCallback() {
    super.disconnectedCallback?.();
    cancelAnimationFrame(this._raf);
    this._raf = null;

    window.removeEventListener('resize', this._onResize);

    if (this._video) {
      this._video.removeEventListener('loadedmetadata', this._onLoadedMeta);
      this._video.removeEventListener('timeupdate', this._onTimeUpdate);
      this._video.removeEventListener('playing', this._onPlaying);
      this._video.removeEventListener('pause', this._onPause);
      this._video.removeEventListener('ended', this._onEnded);
      this._video.removeEventListener('error', this._onError);
    }

    const gl = this._gl;
    if (gl) {
      if (this._tex) gl.deleteTexture(this._tex);
      if (this._vbo) gl.deleteBuffer(this._vbo);
      if (this._prog) gl.deleteProgram(this._prog);
    }
    
    this._gl = this._prog = this._vbo = this._tex = null;
  }

  play() { 
    this._start(); 
  }
  
  pause() { 
    this._video?.pause?.(); 
  }
  
  stop() { 
    if (this._video) { 
      this._video.pause(); 
      this._video.currentTime = 0; 
    } 
  }
  
  seek(t = 0) { 
    if (this._video) {
      this._video.currentTime = Math.max(0, Number(t) || 0); 
    }
  }
  
  setSrc(url) { 
    this.src = url; 
  }

  get currentTime() { 
    return this._video?.currentTime ?? 0; 
  }
  
  get duration() { 
    return this._video?.duration ?? 0; 
  }
  
  get paused() { 
    return this._video?.paused ?? true; 
  }
  
  get ended() { 
    return this._video?.ended ?? false; 
  }

  _onResize() {
    const gl = this._gl;
    const canvas = this._canvas;
    
    if (!gl || !canvas) return;
    
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const displayWidth = Math.floor(canvas.clientWidth * dpr);
    const displayHeight = Math.floor(canvas.clientHeight * dpr);
    
    if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
      canvas.width = displayWidth;
      canvas.height = displayHeight;
    }
    
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  }

  _start() {
    if (!this._video) return;

    this._video.muted = this.muted ?? true;
    this._video.play().catch(() => {});

    if (this._raf == null) {
      this._raf = requestAnimationFrame(this._tick);
    }
  }

  _tick() {
    const gl = this._gl;
    const v = this._video;
    
    if (!gl || !v) return;

    this._onResize();

    if (v.readyState >= v.HAVE_CURRENT_DATA && !v.ended) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
      gl.uniform1i(this._samplerLoc, 0);

      if (!this._firstFrame) {
        this._firstFrame = true;
        this.requestUpdate();
        this.dispatchEvent(new CustomEvent('va-firstframe', { 
          bubbles: true, 
          composed: true 
        }));
      }
    }

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    this._raf = requestAnimationFrame(this._tick);
  }

  _onLoadedMeta = () => {
    this.dispatchEvent(new CustomEvent('va-source-loaded', {
      detail: {
        duration: this.duration,
        videoWidth: this._video.videoWidth,
        videoHeight: this._video.videoHeight
      },
      bubbles: true, 
      composed: true
    }));
  };

  _onTimeUpdate = () => {
    const dur = this.duration || 0;
    const cur = this.currentTime || 0;
    
    this.dispatchEvent(new CustomEvent('va-time', {
      detail: {
        currentTime: cur,
        duration: dur,
        progress: dur ? cur / dur : 0
      },
      bubbles: true, 
      composed: true
    }));
  };

  _onPlaying = () => {
    this.dispatchEvent(new CustomEvent('va-playing', { 
      bubbles: true, 
      composed: true 
    }));
  };

  _onPause = () => {
    this.dispatchEvent(new CustomEvent('va-paused', { 
      bubbles: true, 
      composed: true 
    }));
  };

  _onEnded = () => {
    this.dispatchEvent(new CustomEvent('va-ended', { 
      bubbles: true, 
      composed: true 
    }));
  };

  _onError = () => {
    const err = this._video?.error;
    
    this.dispatchEvent(new CustomEvent('va-error', {
      detail: { 
        code: err?.code ?? 0, 
        message: err?.message ?? 'Video error' 
      },
      bubbles: true, 
      composed: true
    }));
  };
}

if (!customElements.get('vanilla-alpha')) {
  customElements.define('vanilla-alpha', VanillaAlpha);
}

export { VanillaAlpha };