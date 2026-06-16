const Desklet = imports.ui.desklet;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Mainloop = imports.mainloop;
const Settings = imports.ui.settings;
const Lang = imports.lang;
const Cairo = imports.cairo;

const DESKLET_DIR = imports.ui.deskletManager.deskletMeta["cava-visualizer@heydanielhere"].path;
const DATA_FILE = "/tmp/cava_data.json";
const BARS = 20;

function MyDesklet(metadata, desklet_id) {
    this._init(metadata, desklet_id);
}

MyDesklet.prototype = {
    __proto__: Desklet.Desklet.prototype,

    _init: function(metadata, desklet_id) {
        Desklet.Desklet.prototype._init.call(this, metadata, desklet_id);

        // 🛠️ CONFIGURACIÓN BULLETPROOF PARA TRANSPARENCIA ABSOLUTA:
        // 1. Removemos las clases de estilo por defecto del tema de Cinnamon (.desklet, .desklet-with-borders)
        this.actor.set_style_class_name("");
        
        // 2. Forzamos la anulación de cualquier degradado, borde o sombra heredados del tema actual del sistema
        this.actor.style = "background-color: transparent; " +
                           "background-image: none; " +
                           "background-gradient-start: transparent; " +
                           "background-gradient-end: transparent; " +
                           "border: none; " +
                           "box-shadow: none;";

        this.settings = new Settings.DeskletSettings(this, this.metadata["uuid"], desklet_id);

        // Dimensiones
        this.settings.bindProperty(Settings.BindingDirection.IN, "width", "vizWidth", this._rebuild, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "height", "vizHeight", this._rebuild, null);

        // Estilo visual
        this.settings.bindProperty(Settings.BindingDirection.IN, "viz-mode", "vizMode", this._onSettingsChanged, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "bar-count", "barCount", this._onSettingsChanged, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "bar-spacing", "barSpacing", this._onSettingsChanged, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "bar-radius", "barRadius", this._onSettingsChanged, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "mirror", "mirror", this._onSettingsChanged, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "reverse", "reverse", this._onSettingsChanged, null);

        // Colores
        this.settings.bindProperty(Settings.BindingDirection.IN, "use-gradient", "useGradient", this._onSettingsChanged, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "color-1", "color1", this._onSettingsChanged, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "color-2", "color2", this._onSettingsChanged, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "color-3", "color3", this._onSettingsChanged, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "color-opacity", "colorOpacity", this._onSettingsChanged, null);

        // Fondo
        this.settings.bindProperty(Settings.BindingDirection.IN, "bg-color", "bgColor", this._onSettingsChanged, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "bg-opacity", "bgOpacity", this._onSettingsChanged, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "bg-radius", "bgRadius", this._onSettingsChanged, null);

        // Línea (modo wave/line)
        this.settings.bindProperty(Settings.BindingDirection.IN, "line-width", "lineWidth", this._onSettingsChanged, null);
        this.settings.bindProperty(Settings.BindingDirection.IN, "fill-wave", "fillWave", this._onSettingsChanged, null);

        this._values = new Array(BARS).fill(0);
        this._backendPid = null;

        this._startBackend();
        this._rebuild();
        this._updateLoop();
    },

    _startBackend: function() {
        let backendPath = DESKLET_DIR + "/cava_backend.py";
        try {
            let [ok, pid] = GLib.spawn_async(
                null,
                ["python3", backendPath],
                null,
                GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                null
            );
            if (ok) {
                this._backendPid = pid;
            }
        } catch(e) {
            global.logError("Cava backend error: " + e);
        }
    },

    _parseColor: function(colorStr) {
        if (!colorStr) return [0, 0, 0];
        
        colorStr = colorStr.trim();

        if (colorStr.indexOf("rgb") !== -1) {
            let matches = colorStr.match(/\d+/g);
            if (matches && matches.length >= 3) {
                return [
                    parseInt(matches[0], 10) / 255,
                    parseInt(matches[1], 10) / 255,
                    parseInt(matches[2], 10) / 255
                ];
            }
        }

        let hex = colorStr.replace("#", "");
        if (hex.length === 3) hex = hex.split("").map(c => c+c).join("");
        if (hex.length === 6) {
            return [
                parseInt(hex.substring(0,2), 16) / 255,
                parseInt(hex.substring(2,4), 16) / 255,
                parseInt(hex.substring(4,6), 16) / 255
            ];
        }

        return [0, 0, 0];
    },

    _readData: function() {
        try {
            let file = Gio.File.new_for_path(DATA_FILE);
            let [ok, contents] = file.load_contents(null);
            if (!ok) return;
            let text = new TextDecoder().decode(contents);
            let data = JSON.parse(text);
            if (data && data.bars && data.bars.length > 0) {
                let count = this.barCount || 20;
                let src = data.bars;
                let result = [];
                for (let i = 0; i < count; i++) {
                    let idx = (i / count) * src.length;
                    let lo = Math.floor(idx);
                    let hi = Math.min(lo + 1, src.length - 1);
                    let t = idx - lo;
                    result.push(src[lo] * (1-t) + src[hi] * t);
                }
                for (let i = 0; i < count; i++) {
                    this._values[i] = (this._values[i] || 0) * 0.4 + result[i] * 0.6;
                }
            }
        } catch(e) {}
    },

    _rebuild: function() {
        if (this._canvas) {
            this._canvas.destroy();
        }

        let w = this.vizWidth || 400;
        let h = this.vizHeight || 150;

        this._canvas = new Clutter.Canvas();
        this._canvas.set_size(w, h);
        this._canvas.connect("draw", Lang.bind(this, this._draw));

        let actor = new Clutter.Actor();
        actor.set_size(w, h);
        actor.set_content(this._canvas);

        this.setContent(actor);
        this._canvas.invalidate();
    },

    _draw: function(canvas, cr, width, height) {
        cr.save();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.restore();

        let bgOpacity = this.bgOpacity !== undefined ? this.bgOpacity : 0;
        if (bgOpacity > 0) {
            let bg = this._parseColor(this.bgColor || "#000000");
            let radius = this.bgRadius || 0;
            cr.save();
            if (radius > 0) {
                cr.arc(radius, radius, radius, Math.PI, 1.5*Math.PI);
                cr.arc(width-radius, radius, radius, 1.5*Math.PI, 2*Math.PI);
                cr.arc(width-radius, height-radius, radius, 0, 0.5*Math.PI);
                cr.arc(radius, height-radius, radius, 0.5*Math.PI, Math.PI);
                cr.closePath();
            } else {
                cr.rectangle(0, 0, width, height);
            }
            cr.setSourceRGBA(bg[0], bg[1], bg[2], bgOpacity);
            cr.fill();
            cr.restore();
        }

        let mode = this.vizMode || "bars";
        let values = this._values.slice();
        if (this.reverse) values.reverse();

        let opacity = this.colorOpacity !== undefined ? this.colorOpacity : 1.0;
        let c1 = this._parseColor(this.color1 || "#6b21a8");
        let c2 = this._parseColor(this.color2 || "#e8650a");
        let c3 = this._parseColor(this.color3 || "#cc2200");

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
        return true;
    },

    _setColor: function(cr, x, width, height, y, barH, c1, c2, c3, opacity) {
        if (this.useGradient) {
            let grad = new Cairo.LinearGradient(0, y + barH, 0, y);
            grad.addColorStopRGBA(0, c1[0], c1[1], c1[2], opacity);
            grad.addColorStopRGBA(0.5, c2[0], c2[1], c2[2], opacity);
            grad.addColorStopRGBA(1, c3[0], c3[1], c3[2], opacity);
            cr.setSource(grad);
        } else {
            cr.setSourceRGBA(c1[0], c1[1], c1[2], opacity);
        }
    },

    _drawBars: function(cr, width, height, values, c1, c2, c3, opacity, mirrored) {
        let count = values.length;
        let spacing = this.barSpacing !== undefined ? this.barSpacing : 2;
        let radius = this.barRadius !== undefined ? this.barRadius : 3;
        let barW = (width - spacing * (count - 1)) / count;

        for (let i = 0; i < count; i++) {
            let x = i * (barW + spacing);
            let barH = Math.max(2, values[i] * height * 0.95);

            if (mirrored) {
                let halfH = barH / 2;
                let y = (height - barH) / 2;
                this._setColor(cr, x, barW, height, y, barH, c1, c2, c3, opacity);
                this._roundRect(cr, x, y, barW, barH, radius);
                cr.fill();
            } else {
                let y = height - barH;
                this._setColor(cr, x, barW, height, y, barH, c1, c2, c3, opacity);
                this._roundRect(cr, x, y, barW, barH, radius);
                cr.fill();
            }
        }
    },

    _drawWave: function(cr, width, height, values, c1, c2, c3, opacity, mirrored) {
        let count = values.length;
        let fill = this.fillWave !== undefined ? this.fillWave : true;
        let lw = this.lineWidth || 2;

        let grad = new Cairo.LinearGradient(0, height, 0, 0);
        grad.addColorStopRGBA(0, c1[0], c1[1], c1[2], opacity);
        grad.addColorStopRGBA(0.5, c2[0], c2[1], c2[2], opacity);
        grad.addColorStopRGBA(1, c3[0], c3[1], c3[2], opacity * 0.3);
        cr.setSource(grad);

        cr.setLineWidth(lw);
        let step = width / (count - 1);

        cr.moveTo(0, height - values[0] * height * 0.9);
        for (let i = 1; i < count; i++) {
            let x = i * step;
            let y = height - values[i] * height * 0.9;
            let px = (i - 1) * step;
            let py = height - values[i-1] * height * 0.9;
            let cpx = (px + x) / 2;
            cr.curveTo(cpx, py, cpx, y, x, y);
        }

        if (fill) {
            cr.lineTo(width, height);
            cr.lineTo(0, height);
            cr.closePath();
            cr.fillPreserve();
            cr.setSourceRGBA(c3[0], c3[1], c3[2], opacity);
            cr.stroke();
        } else {
            cr.stroke();
        }

        if (mirrored) {
            cr.setSource(grad);
            cr.moveTo(0, values[0] * height * 0.9);
            for (let i = 1; i < count; i++) {
                let x = i * step;
                let y = values[i] * height * 0.9;
                let px = (i-1) * step;
                let py = values[i-1] * height * 0.9;
                let cpx = (px + x) / 2;
                cr.curveTo(cpx, py, cpx, y, x, y);
            }
            if (fill) {
                cr.lineTo(width, 0);
                cr.lineTo(0, 0);
                cr.closePath();
                cr.fillPreserve();
                cr.setSourceRGBA(c3[0], c3[1], c3[2], opacity);
                cr.stroke();
            } else {
                cr.stroke();
            }
        }
    },

    _drawLine: function(cr, width, height, values, c1, c2, c3, opacity) {
        let count = values.length;
        let lw = this.lineWidth || 2;
        let step = width / (count - 1);

        let grad = new Cairo.LinearGradient(0, 0, width, 0);
        grad.addColorStopRGBA(0, c1[0], c1[1], c1[2], opacity);
        grad.addColorStopRGBA(0.5, c2[0], c2[1], c2[2], opacity);
        grad.addColorStopRGBA(1, c3[0], c3[1], c3[2], opacity);
        cr.setSource(grad);
        cr.setLineWidth(lw);

        cr.moveTo(0, height/2 - values[0] * height/2 * 0.9);
        for (let i = 1; i < count; i++) {
            let x = i * step;
            let y = height/2 - values[i] * height/2 * 0.9;
            let px = (i-1) * step;
            let py = height/2 - values[i-1] * height/2 * 0.9;
            let cpx = (px + x) / 2;
            cr.curveTo(cpx, py, cpx, y, x, y);
        }
        cr.stroke();

        cr.moveTo(0, height/2 + values[0] * height/2 * 0.9);
        for (let i = 1; i < count; i++) {
            let x = i * step;
            let y = height/2 + values[i] * height/2 * 0.9;
            let px = (i-1) * step;
            let py = height/2 + values[i-1] * height/2 * 0.9;
            let cpx = (px + x) / 2;
            cr.curveTo(cpx, py, cpx, y, x, y);
        }
        cr.stroke();
    },

    _drawDots: function(cr, width, height, values, c1, c2, c3, opacity) {
        let count = values.length;
        let step = width / count;
        let maxR = step * 0.45;

        for (let i = 0; i < count; i++) {
            let x = i * step + step/2;
            let r = Math.max(2, values[i] * maxR);
            let t = i / count;
            let rc = c1[0] * (1-t) + c3[0] * t;
            let gc = c1[1] * (1-t) + c3[1] * t;
            let bc = c1[2] * (1-t) + c3[2] * t;

            cr.arc(x, height/2, r, 0, 2*Math.PI);
            cr.setSourceRGBA(rc, gc, bc, opacity);
            cr.fill();

            if (values[i] > 0.3) {
                cr.arc(x, height/2, r * 1.5, 0, 2*Math.PI);
                cr.setSourceRGBA(rc, gc, bc, opacity * 0.2);
                cr.fill();
            }
        }
    },

    _roundRect: function(cr, x, y, w, h, r) {
        if (r <= 0) {
            cr.rectangle(x, y, w, h);
            return;
        }
        r = Math.min(r, w/2, h/2);
        cr.moveTo(x + r, y);
        cr.lineTo(x + w - r, y);
        cr.arc(x + w - r, y + r, r, -Math.PI/2, 0);
        cr.lineTo(x + w, y + h - r);
        cr.arc(x + w - r, y + h - r, r, 0, Math.PI/2);
        cr.lineTo(x + r, y + h);
        cr.arc(x + r, y + h - r, r, Math.PI/2, Math.PI);
        cr.lineTo(x, y + r);
        cr.arc(x + r, y + r, r, Math.PI, 3*Math.PI/2);
        cr.closePath();
    },

    _updateLoop: function() {
        this._readData();
        if (this._canvas) {
            this._canvas.invalidate();
        }
        this._timeout = Mainloop.timeout_add(33, Lang.bind(this, this._updateLoop));
        return false;
    },

    _onSettingsChanged: function() {
        if (this._canvas) this._canvas.invalidate();
    },

    on_desklet_removed: function() {
        if (this._timeout) Mainloop.source_remove(this._timeout);
        if (this._backendPid) {
            try { GLib.spawn_command_line_async("kill " + this._backendPid); } catch(e) {}
        }
        try { GLib.spawn_command_line_async("pkill -f cava_backend.py"); } catch(e) {}
    }
};

function main(metadata, desklet_id) {
    return new MyDesklet(metadata, desklet_id);
}