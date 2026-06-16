const Desklet = imports.ui.desklet;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Settings = imports.ui.settings;
const Cairo = imports.cairo;

const UUID = "cava-visualizer@heydanielhere";
const DESKLET_DIR = imports.ui.deskletManager.deskletMeta[UUID].path;

function MyDesklet(metadata, desklet_id) {
    this._init(metadata, desklet_id);
}

MyDesklet.prototype = {
    __proto__: Desklet.Desklet.prototype,

    _init: function(metadata, desklet_id) {
        Desklet.Desklet.prototype._init.call(this, metadata, desklet_id);

        this.actor.set_style_class_name("");
        this.actor.style = "background-color: transparent; background-image: none; border: none; box-shadow: none;";

        this.settings = new Settings.DeskletSettings(this, this.metadata["uuid"], desklet_id);

        this._cavaProcess = null;
        this._dataStream = null;
        this._backendActive = false;
        this._values = [];
        this._isIdle = true;
        
        this._lastDataTime = GLib.get_monotonic_time();

        this._bindPreferences();
        this._startCavaPipeline();
        this._rebuildCanvas();

        // Watchdog: Protección ante reinicios de PipeWire/Audio
        this._watchdogId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            let now = GLib.get_monotonic_time();
            if (now - this._lastDataTime > 2200000) {
                this._startCavaPipeline();
            }
            return true;
        });
    },

    _bindPreferences: function() {
        this.settings.bindProperty(Settings.BindingDirection.IN, "width", "vizWidth", () => this._rebuildCanvas(), null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "height", "vizHeight", () => this._rebuildCanvas(), null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "viz-mode", "vizMode", () => this._queueDraw(), null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "bar-count", "barCount", () => this._startCavaPipeline(), null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "bar-spacing", "barSpacing", () => this._queueDraw(), null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "bar-radius", "barRadius", () => this._queueDraw(), null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "mirror", "mirror", () => this._queueDraw(), null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "reverse", "reverse", () => this._queueDraw(), null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "use-gradient", "useGradient", () => this._queueDraw(), null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "color-1", "color1", () => this._queueDraw(), null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "color-2", "color2", () => this._queueDraw(), null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "color-3", "color3", () => this._queueDraw(), null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "color-opacity", "colorOpacity", () => this._queueDraw(), null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "bg-color", "bgColor", () => this._queueDraw(), null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "bg-opacity", "bgOpacity", () => this._queueDraw(), null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "bg-radius", "bgRadius", () => this._queueDraw(), null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "line-width", "lineWidth", () => this._queueDraw(), null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "fill-wave", "fillWave", () => this._queueDraw(), null);
    },

    _startCavaPipeline: function() {
        this._stopCavaPipeline();
        this._lastDataTime = GLib.get_monotonic_time();

        let count = this.barCount || 20;
        this._values = new Array(count).fill(0.0);

        let configPath = GLib.get_user_runtime_dir() + "/cava_desklet_" + this.metadata["uuid"] + ".conf";
        let configContent = 
            "[general]\n" +
            "bars = " + count + "\n" +
            "framerate = 60\n" +
            "autosens = 1\n" +
            "overshoot = 2\n" +
            "[output]\n" +
            "method = raw\n" +
            "data_format = ascii\n" +
            "ascii_max_range = 255\n" +
            "bar_delimiter = 59\n";

        try {
            GLib.file_set_contents(configPath, configContent);
            
            let [ok, pid, stdin, stdout, stderr] = GLib.spawn_async_with_pipes(
                null,
                ["cava", "-p", configPath],
                null,
                GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                null
            );

            if (ok) {
                this._cavaProcess = pid;
                this._backendActive = true;
                
                let unixStream = new Gio.UnixInputStream({ fd: stdout, close_fd: true });
                this._dataStream = new Gio.DataInputStream({ base_stream: unixStream });
                
                this._readNextLine();
            }
        } catch (e) {
            global.logError("[" + UUID + "] CAVA Spawn Error: " + e);
        }
    },

    _readNextLine: function() {
        if (!this._backendActive || !this._dataStream) return;

        this._dataStream.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
            try {
                let [line, len] = stream.read_line_finish_utf8(res);
                if (line !== null) {
                    this._parseCavaOutput(line);
                    this._readNextLine();
                } else {
                    this._stopCavaPipeline();
                }
            } catch (e) {
                this._stopCavaPipeline();
            }
        });
    },

    _parseCavaOutput: function(line) {
        this._lastDataTime = GLib.get_monotonic_time();

        let parts = line.split(';');
        let count = this._values.length;
        let totalEnergy = 0;
        let newValues = [];

        for (let i = 0; i < count; i++) {
            let val = parseInt(parts[i], 10) / 255.0;
            let cleanVal = isNaN(val) ? 0.0 : val;
            newValues.push(cleanVal);
            totalEnergy += cleanVal;
        }

        for (let i = 0; i < count; i++) {
            this._values[i] = this._values[i] * 0.3 + newValues[i] * 0.7;
        }

        if (totalEnergy === 0) {
            if (!this._isIdle) {
                this._isIdle = true;
                this._queueDraw();
            }
        } else {
            this._isIdle = false;
            this._queueDraw();
        }
    },

    _queueDraw: function() {
        if (this._canvas && (!this._isIdle || this.bgOpacity > 0)) {
            this._canvas.invalidate();
        }
    },

    _rebuildCanvas: function() {
        if (this._canvas) this._canvas.destroy();

        let w = this.vizWidth || 400;
        let h = this.vizHeight || 150;

        this._canvas = new Clutter.Canvas();
        this._canvas.set_size(w, h);
        this._canvas.connect("draw", (canvas, cr, width, height) => {
            this._draw(cr, width, height);
            return true;
        });

        let actor = new Clutter.Actor({ width: w, height: h, content: this._canvas });
        this.setContent(actor);
        this._canvas.invalidate();
    },

    _parseColor: function(str) {
        if (!str) return [1, 1, 1];
        if (str.indexOf("rgb") !== -1) {
            let matches = str.match(/\d+/g);
            if (matches && matches.length >= 3) {
                return [parseInt(matches[0], 10)/255, parseInt(matches[1], 10)/255, parseInt(matches[2], 10)/255];
            }
        }
        let hex = str.replace("#", "");
        if (hex.length === 6) {
            return [parseInt(hex.substring(0,2),16)/255, parseInt(hex.substring(2,4),16)/255, parseInt(hex.substring(4,6),16)/255];
        }
        return [1, 1, 1];
    },

    _draw: function(cr, width, height) {
        cr.save();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.restore();

        let bgOpacity = this.bgOpacity !== undefined ? this.bgOpacity : 0.0;
        if (bgOpacity > 0) {
            let bg = this._parseColor(this.bgColor || "#000000");
            cr.save();
            this._roundRect(cr, 0, 0, width, height, this.bgRadius || 0);
            cr.setSourceRGBA(bg[0], bg[1], bg[2], bgOpacity);
            cr.fill();
            cr.restore();
        }

        let values = this._values.slice();
        if (this.reverse) values.reverse();
        if (this.mirror && values.length > 1) {
            let half = values.slice(0, Math.ceil(values.length / 2));
            let reversedHalf = half.slice().reverse();
            values = half.concat(reversedHalf).slice(0, values.length);
        }

        let opacity = this.colorOpacity !== undefined ? this.colorOpacity : 1.0;
        let c1 = this._parseColor(this.color1 || "#6b21a8");
        let c2 = this._parseColor(this.color2 || "#e8650a");
        let c3 = this._parseColor(this.color3 || "#cc2200");
        let mode = this.vizMode || "bars";

        cr.save();
        if (mode === "bars" || mode === "bars-mirror") {
            this._drawBars(cr, width, height, values, c1, c2, c3, opacity, mode === "bars-mirror");
        } else if (mode === "wave" || mode === "wave-mirror") {
            this._drawWave(cr, width, height, values, c1, c2, c3, opacity, mode === "wave-mirror");
        } else if (mode === "line") {
            this._drawLine(cr, width, height, values, c1, c2, c3, opacity);
        } else if (mode === "dots") {
            this._drawDots(cr, width, height, values, c1, c2, c3, opacity);
        }
        cr.restore();
    },

    _applyColors: function(cr, y, barH, height, c1, c2, c3, opacity) {
        if (this.useGradient) {
            let grad = new Cairo.LinearGradient(0, height, 0, height - barH);
            grad.addColorStopRGBA(0.0, c1[0], c1[1], c1[2], opacity);
            grad.addColorStopRGBA(0.5, c2[0], c2[1], c2[2], opacity);
            grad.addColorStopRGBA(1.0, c3[0], c3[1], c3[2], opacity);
            cr.setSource(grad);
        } else {
            cr.setSourceRGBA(c1[0], c1[1], c1[2], opacity);
        }
    },

    _drawBars: function(cr, width, height, values, c1, c2, c3, opacity, isMirror) {
        let count = values.length;
        let spacing = this.barSpacing !== undefined ? this.barSpacing : 2;
        let radius = this.barRadius !== undefined ? this.barRadius : 3;
        let barW = (width - (spacing * (count - 1))) / count;

        for (let i = 0; i < count; i++) {
            let x = i * (barW + spacing);
            let barH = Math.max(2, values[i] * height * 0.95);

            cr.save();
            if (isMirror) {
                let y = (height - barH) / 2;
                this._applyColors(cr, y, barH, height, c1, c2, c3, opacity);
                this._roundRect(cr, x, y, barW, barH, radius);
            } else {
                let y = height - barH;
                this._applyColors(cr, y, barH, height, c1, c2, c3, opacity);
                this._roundRect(cr, x, y, barW, barH, radius);
            }
            cr.fill();
            cr.restore();
        }
    },

    _drawWave: function(cr, width, height, values, c1, c2, c3, opacity, isMirror) {
        let count = values.length;
        let step = width / (count - 1);
        let lw = this.lineWidth || 2;
        let fill = this.fillWave !== undefined ? this.fillWave : true;

        let renderPath = (originY, multiplier) => {
            cr.moveTo(0, originY - (values[0] * height * 0.45 * multiplier));
            for (let i = 1; i < count; i++) {
                let x = i * step;
                let y = originY - (values[i] * height * 0.45 * multiplier);
                let cx = (i - 0.5) * step;
                let prevY = originY - (values[i-1] * height * 0.45 * multiplier);
                cr.curveTo(cx, prevY, cx, y, x, y);
            }
        };

        cr.save();
        cr.setLineWidth(lw);

        let midY = isMirror ? height / 2 : height;
        let scaleMult = isMirror ? 1.0 : 2.0;

        renderPath(midY, scaleMult);
        if (fill) {
            cr.lineTo(width, midY);
            cr.lineTo(0, midY);
            cr.closePath();
            let grad = new Cairo.LinearGradient(0, midY, 0, 0);
            grad.addColorStopRGBA(0, c1[0], c1[1], c1[2], opacity * 0.2);
            grad.addColorStopRGBA(1, c3[0], c3[1], c3[2], opacity * 0.8);
            cr.setSource(grad);
            cr.fillPreserve();
        }
        cr.setSourceRGBA(c3[0], c3[1], c3[2], opacity);
        cr.stroke();

        if (isMirror) {
            renderPath(midY, -1.0);
            if (fill) {
                cr.lineTo(width, midY);
                cr.lineTo(0, midY);
                cr.closePath();
                let grad = new Cairo.LinearGradient(0, midY, 0, height);
                grad.addColorStopRGBA(0, c1[0], c1[1], c1[2], opacity * 0.2);
                grad.addColorStopRGBA(1, c3[0], c3[1], c3[2], opacity * 0.8);
                cr.setSource(grad);
                cr.fillPreserve();
            }
            cr.setSourceRGBA(c3[0], c3[1], c3[2], opacity);
            cr.stroke();
        }
        cr.restore();
    },

    // 🟢 OPTIMIZADO: Función de Línea Simétrica con curvas suavizadas e interpolación armónica
    _drawLine: function(cr, width, height, values, c1, c2, c3, opacity) {
        let count = values.length;
        let step = width / (count - 1);
        let midY = height / 2;

        cr.save();
        cr.setLineWidth(this.lineWidth || 2);
        cr.setLineJoin(Cairo.LineJoin.ROUND); // Redondear uniones de vértices
        cr.setLineCap(Cairo.LineCap.ROUND);   // Redondear extremos finales

        let grad = new Cairo.LinearGradient(0, 0, width, 0);
        grad.addColorStopRGBA(0.0, c1[0], c1[1], c1[2], opacity);
        grad.addColorStopRGBA(0.5, c2[0], c2[1], c2[2], opacity);
        grad.addColorStopRGBA(1.0, c3[0], c3[1], c3[2], opacity);
        cr.setSource(grad);

        // Sub-función para trazar la línea usando curvas de Bézier cúbicas continuas
        let renderSmoothPath = (multiplier) => {
            let startY = midY + (values[0] * midY * 0.88 * multiplier);
            cr.moveTo(0, startY);

            for (let i = 1; i < count; i++) {
                let x = i * step;
                let y = midY + (values[i] * midY * 0.88 * multiplier);
                
                let cx1 = (i - 0.5) * step;
                let cy1 = midY + (values[i-1] * midY * 0.88 * multiplier);
                let cx2 = (i - 0.5) * step;
                let cy2 = y;

                cr.curveTo(cx1, cy1, cx2, cy2, x, y);
            }
        };

        // Renderizar trazo simétrico superior
        renderSmoothPath(-1.0);
        cr.stroke();

        // Renderizar trazo simétrico inferior
        renderSmoothPath(1.0);
        cr.stroke();

        cr.restore();
    },

    _drawDots: function(cr, width, height, values, c1, c2, c3, opacity) {
        let count = values.length;
        let step = width / count;
        let midY = height / 2;
        let maxR = step * 0.45;

        for (let i = 0; i < count; i++) {
            let x = i * step + (step / 2);
            let r = Math.max(2, values[i] * maxR);
            let t = i / count;

            let rc = c1[0] * (1-t) + c3[0] * t;
            let gc = c1[1] * (1-t) + c3[1] * t;
            let bc = c1[2] * (1-t) + c3[2] * t;

            cr.setSourceRGBA(rc, gc, bc, opacity);
            cr.arc(x, midY, r, 0, 2 * Math.PI);
            cr.fill();

            if (values[i] > 0.4) {
                cr.setSourceRGBA(rc, gc, bc, opacity * 0.25);
                cr.arc(x, midY, r * 1.6, 0, 2 * Math.PI);
                cr.fill();
            }
        }
    },

    _roundRect: function(cr, x, y, w, h, r) {
        if (r <= 0) {
            cr.rectangle(x, y, w, h);
            return;
        }
        r = Math.min(r, w / 2, h / 2);
        cr.moveTo(x + r, y);
        cr.lineTo(x + w - r, y);
        cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
        cr.lineTo(x + w, y + h - r);
        cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
        cr.lineTo(x + r, y + h);
        cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
        cr.lineTo(x, y + r);
        cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
        cr.closePath();
    },

    _stopCavaPipeline: function() {
        this._backendActive = false;
        if (this._dataStream) {
            try { this._dataStream.close(null); } catch (e) {}
            this._dataStream = null;
        }
        if (this._cavaProcess) {
            GLib.spawn_command_line_async("kill " + this._cavaProcess);
            GLib.spawn_close_pid(this._cavaProcess);
            this._cavaProcess = null;
        }
    },

    on_desklet_removed: function() {
        if (this._watchdogId) {
            GLib.source_remove(this._watchdogId);
            this._watchdogId = null;
        }
        this._stopCavaPipeline();
    }
};

function main(metadata, desklet_id) {
    return new MyDesklet(metadata, desklet_id);
}
