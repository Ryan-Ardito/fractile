import { useEffect, useRef, useState } from "react";
import { AnimateDirection, useAppContext } from "../AppContext";
import {
  EXPORT_RESOLUTIONS,
  ExportCancelledError,
  ExportOptions,
  ExportProgress,
  VideoExporter,
  estimateExport,
} from "../engine/export";

type ExportUiState =
  | { kind: "idle" }
  | { kind: "running"; progress: ExportProgress }
  | { kind: "error"; message: string };

type SaveFilePicker = (options?: {
  suggestedName?: string;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}) => Promise<FileSystemFileHandle>;

// Open the OS save dialog and return the chosen file handle, or null if the
// browser has no File System Access API or the user dismissed the dialog. Must
// be called from a user gesture (the picker button / export click).
const pickSaveFile = async (
  suggestedName: string
): Promise<FileSystemFileHandle | null> => {
  const picker = (window as { showSaveFilePicker?: SaveFilePicker })
    .showSaveFilePicker;
  if (!picker) return null;
  try {
    return await picker.call(window, {
      suggestedName,
      types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }],
    });
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") return null;
    throw e;
  }
};

// m:ss, for the exact elapsed readout.
const fmtDuration = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
};

// Coarse buckets for the remaining estimate. The per-frame/tile work units
// aren't uniform, so a to-the-second countdown just jitters and reads as
// precision we don't have — round to 15s steps, then whole minutes.
const fmtEstimate = (seconds: number): string => {
  if (seconds < 45) return `${Math.max(15, Math.round(seconds / 15) * 15)}s`;
  return `${Math.round(seconds / 60)} min`;
};

// Approximate file size, MB then GB.
const fmtSize = (bytes: number): string => {
  const mb = bytes / 1e6;
  if (mb < 1000) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1000).toFixed(1)} GB`;
};

export const Menu = () => {
  const { viewer, animationValues, controlValues, updateControlValues } =
    useAppContext();
  const menuCollapsed = controlValues.menuCollapsed;

  const visibility = menuCollapsed ? "collapse" : "visible";
  const opacity = menuCollapsed ? "0%" : "100%";
  const menuButtonText = menuCollapsed ? "menu" : "close";
  const animateButtonText = controlValues.isAnimating ? "stop" : "animate";

  const onMenuButtonClick = () => {
    updateControlValues({ type: "TOGGLE_MENU_COLLAPSED" });
  };

  // Accordion: at most one settings section open at a time. Expanding one
  // collapses whichever was open.
  const [openSection, setOpenSection] = useState<string | null>(null);

  // Export settings. Consumed only when an export starts (passed to the
  // VideoExporter), so plain local state rather than the style reducer.
  const [exportZoomSpeed, setExportZoomSpeed] = useState(2); // levels/sec
  const [exportResolution, setExportResolution] = useState(0); // EXPORT_RESOLUTIONS index
  // Current view zoom, polled while the menu is open so the size/duration
  // estimate tracks the view the movie will end on.
  const [currentZoom, setCurrentZoom] = useState(0);
  useEffect(() => {
    if (menuCollapsed) return;
    const read = () => {
      const z = viewer.current?.getZoom();
      if (typeof z === "number") setCurrentZoom(z);
    };
    read();
    const id = window.setInterval(read, 400);
    return () => clearInterval(id);
  }, [menuCollapsed, viewer]);

  const [exportState, setExportState] = useState<ExportUiState>({
    kind: "idle",
  });
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [exportHover, setExportHover] = useState(false);
  const exporterRef = useRef<VideoExporter | null>(null);
  const errorTimer = useRef<number | undefined>(undefined);
  const confirmTimer = useRef<number | undefined>(undefined);
  const exportStartRef = useRef<number>(0);
  // Ticks once a second while exporting so the elapsed/remaining readout keeps
  // advancing between the exporter's own progress callbacks.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (exportState.kind !== "running") return;
    const id = window.setInterval(() => forceTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [exportState.kind]);

  const clearConfirmCancel = () => {
    clearTimeout(confirmTimer.current);
    setConfirmCancel(false);
  };

  const onExportClick = async () => {
    // While running, the first click arms a confirmation; a second click
    // within the window actually cancels.
    if (exporterRef.current) {
      if (!confirmCancel) {
        setConfirmCancel(true);
        clearTimeout(confirmTimer.current);
        confirmTimer.current = window.setTimeout(
          () => setConfirmCancel(false),
          4000
        );
        return;
      }
      clearConfirmCancel();
      exporterRef.current.cancel();
      return;
    }
    const v = viewer.current;
    if (!v) return;
    // If colors are animating, the movie animates them too — snapshot the
    // state at click time (the exporter re-runs the stepping math in video
    // time; see ColorAnimation in export.ts).
    const anim = animationValues.current;
    const colorAnimation = anim.isAnimating
      ? {
          bandOffset: anim.bandOffset,
          hueOffset: anim.hueOffset,
          bandDirection: anim.bandDirection,
          hueDirection: anim.hueDirection,
          bandHueSpeed: anim.bandHueSpeed,
          frameDuration: anim.frameDuration,
        }
      : undefined;

    // Open the save dialog now, while this click's activation is live. A null
    // handle from a File System Access browser means the user dismissed the
    // dialog — abort before we disturb anything. (Without the API, handle stays
    // null and the exporter falls back to a plain download.)
    const handle = await pickSaveFile("fractile-zoom.mp4");
    if (!handle && (window as { showSaveFilePicker?: unknown }).showSaveFilePicker) {
      return;
    }

    if (controlValues.isAnimating) {
      updateControlValues({ type: "TOGGLE_ANIMATING" });
    }
    const res = EXPORT_RESOLUTIONS[exportResolution];
    const exporter = new VideoExporter(v, {
      colorAnimation,
      levelsPerSec: exportZoomSpeed,
      outW: res.w,
      outH: res.h,
    });
    exporterRef.current = exporter;
    // 0 == not yet started; the clock starts on the first progress callback,
    // which the exporter fires once real work begins — keeping any setup out
    // of the elapsed/remaining readout.
    exportStartRef.current = 0;
    setExportState({
      kind: "running",
      progress: { phase: "render", fraction: 0 },
    });
    exporter
      .run((progress) => {
        if (exportStartRef.current === 0) exportStartRef.current = Date.now();
        setExportState({ kind: "running", progress });
      }, handle)
      .then(
        () => {
          exporterRef.current = null;
          clearConfirmCancel();
          setExportState({ kind: "idle" });
        },
        (e) => {
          exporterRef.current = null;
          clearConfirmCancel();
          if (e instanceof ExportCancelledError) {
            setExportState({ kind: "idle" });
            return;
          }
          console.error("video export failed", e);
          setExportState({
            kind: "error",
            message: e instanceof Error ? e.message : String(e),
          });
          clearTimeout(errorTimer.current);
          errorTimer.current = window.setTimeout(
            () => setExportState({ kind: "idle" }),
            5000
          );
        }
      );
  };

  // Headless-test hook (same spirit as window.__fractileSynth): run an
  // export with overridden pacing, reporting progress on the window.
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__fractileExportTest = (
      opts?: ExportOptions
    ) => {
      const v = viewer.current;
      if (!v) return Promise.reject(new Error("viewer not ready"));
      const w = window as unknown as Record<string, unknown>;
      return new VideoExporter(v, opts).run((p) => {
        w.__fractileExportProgress = p;
      });
    };
  }, []);

  const runningLabel = (): string => {
    if (exportState.kind !== "running") return "";
    const pct = Math.floor(exportState.progress.fraction * 100);
    // Clock hasn't started until the picker closes and the first tick lands.
    if (exportStartRef.current === 0) return `exporting ${pct}%`;
    const elapsed = (Date.now() - exportStartRef.current) / 1000;
    if (exportState.progress.phase === "save") {
      return `saving… · ${fmtDuration(elapsed)}`;
    }
    const f = exportState.progress.fraction;
    // Linear extrapolation from progress-so-far; needs a little history before
    // the estimate is worth showing.
    const remaining =
      f > 0.02 && elapsed > 1 ? (elapsed * (1 - f)) / f : null;
    const tail =
      remaining === null ? "" : ` · ~${fmtEstimate(remaining)} left`;
    return `exporting ${pct}% · ${fmtDuration(elapsed)}${tail}`;
  };

  const exportLabel =
    exportState.kind === "running"
      ? confirmCancel
        ? "click again to cancel"
        : runningLabel()
      : exportState.kind === "error"
        ? exportState.message
        : "export zoom video";
  const exportFill =
    exportState.kind === "running"
      ? Math.floor(exportState.progress.fraction * 100)
      : 0;

  // Up/Down move focus between the sliders that are actually on screen — the
  // set changes as sections expand/collapse, so walk the live DOM rather than
  // a fixed index table. Left/Right keep the native value-nudge behavior.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const box = e.currentTarget.closest("#floatingBox");
    if (!box) return;
    const inputs = Array.from(
      box.querySelectorAll<HTMLInputElement>('input[type="range"]')
    );
    const i = inputs.indexOf(e.currentTarget);
    const delta = e.key === "ArrowUp" ? -1 : 1;
    inputs[(i + delta + inputs.length) % inputs.length]?.focus();
  };

  // One accordion section. The header is always visible and never collapses:
  // `action` (the section's primary button) shares the toggle's line, and
  // `header` holds the other always-visible controls. Only `body` (the
  // secondary controls) hides when the section is closed.
  const section = (
    id: string,
    title: string,
    action: React.ReactNode,
    header: React.ReactNode,
    body: React.ReactNode
  ) => {
    const open = openSection === id;
    return (
      <div className="settingsSection">
        <div className="sectionHeaderRow">
          <button
            type="button"
            className="sectionToggle"
            aria-expanded={open}
            onClick={() => setOpenSection(open ? null : id)}
          >
            <span className="chevron">{open ? "▾" : "▸"}</span>
            <span className="sectionTitle">{title}</span>
          </button>
          {action}
        </div>
        {header}
        {open && <div className="sectionBody">{body}</div>}
      </div>
    );
  };

  const exportRes = EXPORT_RESOLUTIONS[exportResolution];
  const exportEst = estimateExport({
    zoom: currentZoom,
    outW: exportRes.w,
    outH: exportRes.h,
    levelsPerSec: exportZoomSpeed,
  });

  return (
    <>
      <button id="menuButton" onClick={onMenuButtonClick}>
        {menuButtonText}
      </button>
      <div id="floatingBox" style={{ visibility, opacity }}>
        {section(
          "colors",
          "colors",
          <button
            id="animateButton"
            onClick={() => updateControlValues({ type: "TOGGLE_ANIMATING" })}
          >
            {animateButtonText}
          </button>,
          <>
            <div className="control">
              <span className="name">animation speed</span>
              <input
                type="range"
                id="animationSpeed"
                min="1"
                max="256"
                step="1"
                value={controlValues.animationSpeed}
                onKeyDown={handleKeyDown}
                onChange={(e) =>
                  updateControlValues({
                    type: "SET_ANIMATION_SPEED",
                    payload: parseFloat(e.target.value),
                  })
                }
              />
              <span className="value">{controlValues.animationSpeed}</span>
            </div>
          </>,
          <>
            <div className="control">
              <span className="name">band/hue speed</span>
              <input
                type="range"
                id="bandHueSpeed"
                min="0"
                max="1"
                step="0.005"
                list="bandHueMarkers"
                value={controlValues.bandHueSpeed}
                onKeyDown={handleKeyDown}
                onChange={(e) =>
                  updateControlValues({
                    type: "SET_BAND_HUE_SPEED",
                    payload: parseFloat(e.target.value),
                  })
                }
              />
              <span className="value">
                {(
                  Math.min(1, (1 - controlValues.bandHueSpeed) * 2) * 100
                ).toFixed(0)}
                /{(Math.min(1, controlValues.bandHueSpeed * 2) * 100).toFixed(0)}
              </span>
            </div>
            <div className="control">
              <span className="name">palette scale</span>
              <input
                type="range"
                id="paletteScale"
                min="1"
                max="10"
                step="0.01"
                value={controlValues.paletteScale}
                onKeyDown={handleKeyDown}
                onChange={(e) =>
                  updateControlValues({
                    type: "SET_PALETTE_SCALE",
                    payload: parseFloat(e.target.value),
                  })
                }
              />
              <span className="value">{controlValues.paletteScale}</span>
            </div>
            <div className="control">
              <span className="name">band spacing</span>
              <input
                type="range"
                id="bandSpacing"
                min="1"
                max="10"
                step="0.005"
                value={controlValues.bandSpacing}
                onKeyDown={handleKeyDown}
                onChange={(e) =>
                  updateControlValues({
                    type: "SET_BAND_SPACING",
                    payload: parseFloat(e.target.value),
                  })
                }
              />
              <span className="value">{controlValues.bandSpacing}</span>
            </div>
            <div className="control">
              <span className="name">band contrast</span>
              <input
                type="range"
                id="bandContrast"
                min="0"
                max="0.5"
                step="0.01"
                value={controlValues.bandContrast}
                onKeyDown={handleKeyDown}
                onChange={(e) =>
                  updateControlValues({
                    type: "SET_BAND_CONTRAST",
                    payload: parseFloat(e.target.value),
                  })
                }
              />
              <span className="value">{controlValues.bandContrast}</span>
            </div>
            <div className="control">
              <span className="name">band offset</span>
              <span className="dirs">
                <button
                  onClick={() =>
                    updateControlValues({
                      type: "SET_BAND_DIRECTION",
                      payload: AnimateDirection.Backward,
                    })
                  }
                  disabled={
                    controlValues.bandDirection != AnimateDirection.Forward
                  }
                >
                  &lt;
                </button>
                <button
                  onClick={() =>
                    updateControlValues({
                      type: "SET_BAND_DIRECTION",
                      payload: AnimateDirection.Forward,
                    })
                  }
                  disabled={
                    controlValues.bandDirection != AnimateDirection.Backward
                  }
                >
                  &gt;
                </button>
              </span>
              <input
                type="range"
                id="bandOffset"
                min="-3.14"
                max="3.14"
                step="0.01"
                list="zeroMarker"
                value={controlValues.bandOffset}
                onKeyDown={handleKeyDown}
                onChange={(e) =>
                  updateControlValues({
                    type: "SET_BAND_OFFSET",
                    payload: parseFloat(e.target.value),
                  })
                }
              />
              <span className="value">
                {controlValues.bandOffset.toFixed(2)}
              </span>
            </div>
            <div className="control">
              <span className="name">hue offset</span>
              <span className="dirs">
                <button
                  onClick={() =>
                    updateControlValues({
                      type: "SET_HUE_DIRECTION",
                      payload: AnimateDirection.Backward,
                    })
                  }
                  disabled={
                    controlValues.hueDirection != AnimateDirection.Forward
                  }
                >
                  &lt;
                </button>
                <button
                  onClick={() =>
                    updateControlValues({
                      type: "SET_HUE_DIRECTION",
                      payload: AnimateDirection.Forward,
                    })
                  }
                  disabled={
                    controlValues.hueDirection != AnimateDirection.Backward
                  }
                >
                  &gt;
                </button>
              </span>
              <input
                type="range"
                id="hueOffset"
                min="-180"
                max="179"
                step="1"
                list="zeroMarker"
                value={controlValues.hueOffset}
                onKeyDown={handleKeyDown}
                onChange={(e) =>
                  updateControlValues({
                    type: "SET_HUE_OFFSET",
                    payload: parseFloat(e.target.value),
                  })
                }
              />
              <span className="value">
                {controlValues.hueOffset.toFixed(0)}
              </span>
            </div>
            <div className="control">
              <span className="name">saturation</span>
              <input
                type="range"
                id="saturation"
                min="0"
                max="2"
                step="0.01"
                list="oneMarker"
                value={controlValues.saturation}
                onKeyDown={handleKeyDown}
                onChange={(e) =>
                  updateControlValues({
                    type: "SET_SATURATION",
                    payload: parseFloat(e.target.value),
                  })
                }
              />
              <span className="value">{controlValues.saturation}</span>
            </div>
            <div className="control">
              <span className="name">lightness</span>
              <input
                type="range"
                id="lightness"
                min="0"
                max="2"
                step="0.01"
                list="oneMarker"
                value={controlValues.lightness}
                onKeyDown={handleKeyDown}
                onChange={(e) =>
                  updateControlValues({
                    type: "SET_LIGHTNESS",
                    payload: parseFloat(e.target.value),
                  })
                }
              />
              <span className="value">{controlValues.lightness}</span>
            </div>
          </>
        )}
        {VideoExporter.isSupported() &&
          section(
            "export",
            "export",
            <button
              id="exportButton"
              onClick={onExportClick}
                onMouseEnter={() => setExportHover(true)}
                onMouseLeave={() => setExportHover(false)}
                title={
                  exportState.kind === "running"
                    ? confirmCancel
                      ? "click again to cancel the export"
                      : "click to cancel"
                    : "export a zoom movie ending at this view"
                }
                style={
                  // While running the fill is an inline gradient, so the
                  // stylesheet :hover (black text on white) can't repaint the
                  // background and would only darken the text. Drive hover
                  // ourselves: keep text white and brighten fill + track.
                  exportState.kind === "running"
                    ? {
                        background: `linear-gradient(to right, ${
                          confirmCancel
                            ? exportHover
                              ? "#9c4f4f"
                              : "#7a3d3d"
                            : exportHover
                              ? "#4f8a67"
                              : "#3d6b4f"
                        } ${exportFill}%, ${
                          exportHover ? "#3a3a3a" : "#303030"
                        } ${exportFill}%)`,
                        color: "white",
                        cursor: "pointer",
                      }
                    : undefined
                }
              >
                {exportLabel}
              </button>,
            <div className="exportEstimate">
              <select
                id="exportResolution"
                value={exportResolution}
                onChange={(e) =>
                  setExportResolution(parseInt(e.target.value, 10))
                }
              >
                {EXPORT_RESOLUTIONS.map((r, i) => (
                  <option key={r.label} value={i}>
                    {r.label} ({r.w}×{r.h})
                  </option>
                ))}
              </select>
              <span className="estimate">
                ~{fmtSize(exportEst.sizeBytes)} · {fmtDuration(exportEst.durationSec)}
              </span>
            </div>,
            <>
              <div className="control">
                <span className="name">zoom speed</span>
                <input
                  type="range"
                  id="exportZoomSpeed"
                  min="0.5"
                  max="6"
                  step="0.5"
                  value={exportZoomSpeed}
                  onKeyDown={handleKeyDown}
                  onChange={(e) =>
                    setExportZoomSpeed(parseFloat(e.target.value))
                  }
                />
                <span className="value">{exportZoomSpeed.toFixed(1)}</span>
              </div>
            </>
          )}
        <datalist id="zeroMarker">
          <option value="0"></option>
        </datalist>
        <datalist id="oneMarker">
          <option value="1"></option>
        </datalist>
        <datalist id="bandHueMarkers">
          <option value="0.25"></option>
          <option value="0.5"></option>
          <option value="0.75"></option>
        </datalist>
      </div>
    </>
  );
};
