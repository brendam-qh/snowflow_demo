/**
 * Controls help. A persistent ⓘ button in the bottom-left opens a modal
 * listing every input the demo accepts, organised by mode (Keyboard/Mouse,
 * Webcam Gestures). Esc, the close button, and a backdrop click all dismiss.
 *
 * The control table lives in CONTROLS below — the same data the modal renders
 * is the canonical list, so editing it in one place updates everything.
 */

const CSS = `
#ghelp-btn {
    position: fixed; left: 14px; bottom: 14px; z-index: 70;
    width: 28px; height: 28px; border-radius: 50%;
    background: rgba(8, 12, 19, 0.72);
    border: 1px solid rgba(143, 196, 232, 0.18);
    color: #cddaea; cursor: pointer; padding: 0;
    font: 500 15px/1 ui-sans-serif, system-ui, sans-serif;
    backdrop-filter: blur(8px);
    transition: background 140ms ease, border-color 140ms ease;
}
#ghelp-btn:hover { background: rgba(20, 28, 42, 0.85); border-color: rgba(143, 196, 232, 0.4); }
#ghelp-btn:focus-visible { outline: 2px solid rgba(143, 196, 232, 0.6); outline-offset: 2px; }

#ghelp-backdrop {
    position: fixed; inset: 0; z-index: 90;
    background: rgba(4, 7, 12, 0.55);
    backdrop-filter: blur(6px);
    display: grid; place-items: center;
    opacity: 0; pointer-events: none;
    transition: opacity 160ms ease;
}
#ghelp-backdrop.show { opacity: 1; pointer-events: auto; }

#ghelp-modal {
    position: relative;
    width: min(560px, 92vw);
    max-height: 84vh; overflow-y: auto;
    background: rgba(8, 12, 19, 0.92);
    border: 1px solid rgba(143, 196, 232, 0.18);
    border-radius: 6px;
    padding: 22px 26px 26px;
    color: #cddaea;
    font: 400 12px/1.55 ui-sans-serif, "Inter", system-ui, sans-serif;
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6);
}
#ghelp-modal h2 {
    font-size: 10px; font-weight: 500; letter-spacing: 0.22em; text-transform: uppercase;
    color: #7d8ea3; margin: 18px 0 10px;
}
#ghelp-modal h2:first-child { margin-top: 0; }
#ghelp-modal .ghelp-hdr {
    display: flex; align-items: baseline; justify-content: space-between;
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(143, 196, 232, 0.10);
}
#ghelp-modal .ghelp-hdr b {
    font-size: 12px; font-weight: 500; letter-spacing: 0.3em; color: #e6eff8;
}
#ghelp-modal .ghelp-hdr i {
    font-style: normal; font-size: 9px; letter-spacing: 0.18em; color: #55677a;
}
#ghelp-modal .ghelp-close {
    position: absolute; top: 12px; right: 14px;
    width: 24px; height: 24px; border-radius: 4px;
    background: transparent; border: 0; color: #7d8ea3;
    font: 500 16px/1 ui-sans-serif, system-ui, sans-serif; cursor: pointer;
    padding: 0;
}
#ghelp-modal .ghelp-close:hover { color: #e6eff8; background: rgba(143, 196, 232, 0.08); }
#ghelp-modal .ghelp-close:focus-visible { outline: 2px solid rgba(143, 196, 232, 0.5); outline-offset: 2px; }

#ghelp-modal table {
    width: 100%; border-collapse: collapse;
}
#ghelp-modal td {
    padding: 5px 8px 5px 0; vertical-align: top;
}
#ghelp-modal td.k {
    width: 38%; color: #dbe6f2; white-space: nowrap;
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px;
    letter-spacing: 0.02em;
}
#ghelp-modal td.v { color: #8fa3b8; }
#ghelp-modal tr.spacer td { padding: 2px 0; height: 4px; }
`;

/**
 * The single source of truth for input controls. `mode` groups rows; `kbd` is
 * what the user does (rendered in monospace); `desc` is what it does.
 */
const CONTROLS = [
    {
        title: "Keyboard / Mouse",
        rows: [
            { kbd: "W A S D", desc: "move (camera-relative)" },
            { kbd: "Mouse", desc: "look · Wheel zoom" },
            { kbd: "Shift", desc: "sprint" },
            { kbd: "Right mouse (hold)", desc: "snow-surf — carve across the field and throw a wake" },
            { kbd: "1 – 5", desc: "spells (2 is a held cast)" },
            { kbd: "F1 / `", desc: "settings and performance overlay" },
        ],
    },
    {
        title: "Webcam Gestures (when tracking is on)",
        rows: [
            { kbd: "Right hand — Open_Palm", desc: "walk" },
            { kbd: "Right hand — palm roll", desc: "steer" },
            { kbd: "Right hand — raised palm", desc: "sprint" },
            { kbd: "Right hand — thumb extended", desc: "snow-surf (no hold required)" },
            { kbd: "Right hand — thumb tilt", desc: "steers the carve while surfing" },
            { kbd: "Left hand — palm forward (open hand, palm out)", desc: "spell 1 — water push" },
            { kbd: "Left hand — victory (two fingers)", desc: "spell 2 — water stream (held)" },
            { kbd: "Left hand — thumb up", desc: "spell 3 — tower column of water" },
            { kbd: "Left hand — thumb down", desc: "spell 4 — ice spikes" },
            { kbd: "Left hand — closed fist (hold)", desc: "spell 5 — vortex" },
        ],
    },
];

export class GestureHelp {
    constructor() {
        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);

        const btn = document.createElement("button");
        btn.id = "ghelp-btn";
        btn.type = "button";
        btn.textContent = "\u24D8";
        btn.title = "Show controls";
        btn.setAttribute("aria-label", "Show controls");
        document.body.appendChild(btn);
        this.btn = btn;

        const backdrop = document.createElement("div");
        backdrop.id = "ghelp-backdrop";
        backdrop.setAttribute("role", "presentation");
        document.body.appendChild(backdrop);
        this.backdrop = backdrop;

        const modal = document.createElement("div");
        modal.id = "ghelp-modal";
        modal.setAttribute("role", "dialog");
        modal.setAttribute("aria-modal", "true");
        modal.setAttribute("aria-label", "Controls");
        modal.tabIndex = -1;
        backdrop.appendChild(modal);
        this.modal = modal;

        // Build content
        const hdr = document.createElement("div");
        hdr.className = "ghelp-hdr";
        hdr.innerHTML = "<b>CONTROLS</b><i>Esc to close</i>";
        modal.appendChild(hdr);

        const close = document.createElement("button");
        close.type = "button";
        close.className = "ghelp-close";
        close.textContent = "\u00D7";
        close.setAttribute("aria-label", "Close");
        modal.appendChild(close);
        this.closeBtn = close;

        for (const section of CONTROLS) {
            const h = document.createElement("h2");
            h.textContent = section.title;
            modal.appendChild(h);
            const table = document.createElement("table");
            for (const row of section.rows) {
                const tr = document.createElement("tr");
                const k = document.createElement("td");
                k.className = "k";
                k.textContent = row.kbd;
                const v = document.createElement("td");
                v.className = "v";
                v.textContent = row.desc;
                tr.appendChild(k);
                tr.appendChild(v);
                table.appendChild(tr);
            }
            modal.appendChild(table);
        }

        // Wire open/close. Backdrop click and the close button both dismiss;
        // Esc dismisses; focus is moved into the modal on open and returned to
        // the trigger on close so keyboard users can repeat the action.
        btn.addEventListener("click", () => this.open());
        close.addEventListener("click", () => this.close());
        backdrop.addEventListener("click", (e) => {
            if (e.target === backdrop) this.close();
        });
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && this.isOpen) this.close();
        });

        this.isOpen = false;
        this._lastFocus = null;
    }

    open() {
        if (this.isOpen) return;
        this._lastFocus = document.activeElement;
        this.backdrop.classList.add("show");
        this.isOpen = true;
        this.modal.focus();
    }

    close() {
        if (!this.isOpen) return;
        this.backdrop.classList.remove("show");
        this.isOpen = false;
        if (this._lastFocus && this._lastFocus instanceof HTMLElement) {
            this._lastFocus.focus();
        }
    }

    toggle() {
        this.isOpen ? this.close() : this.open();
    }
}
