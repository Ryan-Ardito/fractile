import { useEffect, useRef, useState } from "react";
import { AnimateDirection, useAppContext } from "../AppContext";
import {
  ExportCancelledError,
  ExportOptions,
  ExportProgress,
  VideoExporter,
} from "../engine/export";

type ExportUiState =
  | { kind: "idle" }
  | { kind: "running"; progress: ExportProgress }
  | { kind: "error"; message: string };

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

  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

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

  const onExportClick = () => {
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
    // If colors are animating, the movie animates them too — capture the
    // state BEFORE stopping the live animation (the exporter re-runs the
    // stepping math in video time; see ColorAnimation in export.ts).
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
    if (controlValues.isAnimating) {
      updateControlValues({ type: "TOGGLE_ANIMATING" });
    }
    const exporter = new VideoExporter(v, { colorAnimation });
    exporterRef.current = exporter;
    // 0 == not yet started; the clock starts on the first progress callback,
    // which the exporter fires once the save dialog closes (see export.ts).
    // This keeps the file-picker wait out of the elapsed/remaining readout.
    exportStartRef.current = 0;
    setExportState({
      kind: "running",
      progress: { phase: "render", fraction: 0 },
    });
    exporter
      .run((progress) => {
        if (exportStartRef.current === 0) exportStartRef.current = Date.now();
        setExportState({ kind: "running", progress });
      })
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

  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const newIndex =
        (index - 1 + inputRefs.current.length) % inputRefs.current.length;
      inputRefs.current[newIndex]?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const newIndex = (index + 1) % inputRefs.current.length;
      inputRefs.current[newIndex]?.focus();
    }
  };

  return (
    <>
      <button id="menuButton" onClick={onMenuButtonClick}>
        {menuButtonText}
      </button>
      <div id="floatingBox" style={{ visibility, opacity }}>
        <button
          id="animateButton"
          onClick={() => updateControlValues({ type: "TOGGLE_ANIMATING" })}
        >
          {animateButtonText}
        </button>
        {VideoExporter.isSupported() && (
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
              // While running the fill is an inline gradient, so the stylesheet
              // :hover (black text on white) can't repaint the background and
              // would only darken the text. Drive hover ourselves instead:
              // keep the text white and brighten the fill + track on hover.
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
          </button>
        )}
        <div>
          <label>
            animation speed: {controlValues.animationSpeed} bpm
            <input
              type="range"
              id="animationSpeed"
              min="1"
              max="256"
              step="1"
              value={controlValues.animationSpeed}
              ref={(el) => (inputRefs.current[0] = el)}
              onKeyDown={(e) => handleKeyDown(e, 0)}
              onChange={(e) => {
                updateControlValues({
                  type: "SET_ANIMATION_SPEED",
                  payload: parseFloat(e.target.value),
                });
              }}
            />
          </label>
        </div>
        <div>
          <label>
            band/hue speed:{" "}
            {(Math.min(1, (1 - controlValues.bandHueSpeed) * 2) * 100).toFixed(
              0
            )}{" "}
            % / {(Math.min(1, controlValues.bandHueSpeed * 2) * 100).toFixed(0)}{" "}
            %
            <input
              type="range"
              id="bandHueSpeed"
              min="0"
              max="1"
              step="0.005"
              value={controlValues.bandHueSpeed}
              list="bandHueMarkers"
              ref={(el) => (inputRefs.current[1] = el)}
              onKeyDown={(e) => handleKeyDown(e, 1)}
              onChange={(e) =>
                updateControlValues({
                  type: "SET_BAND_HUE_SPEED",
                  payload: parseFloat(e.target.value),
                })
              }
            />
          </label>
        </div>
        <div>
          <label>
            palette scale: {controlValues.paletteScale}
            <input
              type="range"
              id="paletteScale"
              min="1"
              max="10"
              step="0.01"
              value={controlValues.paletteScale}
              ref={(el) => (inputRefs.current[2] = el)}
              onKeyDown={(e) => handleKeyDown(e, 2)}
              onChange={(e) =>
                updateControlValues({
                  type: "SET_PALETTE_SCALE",
                  payload: parseFloat(e.target.value),
                })
              }
            />
          </label>
        </div>
        <div>
          <label>
            band spacing: {controlValues.bandSpacing}
            <input
              type="range"
              id="bandSpacing"
              min="1"
              max="10"
              step="0.005"
              value={controlValues.bandSpacing}
              ref={(el) => (inputRefs.current[3] = el)}
              onKeyDown={(e) => handleKeyDown(e, 3)}
              onChange={(e) =>
                updateControlValues({
                  type: "SET_BAND_SPACING",
                  payload: parseFloat(e.target.value),
                })
              }
            />
          </label>
        </div>
        <div>
          <label>
            band contrast: {controlValues.bandContrast}
            <input
              type="range"
              id="bandContrast"
              min="0"
              max="0.5"
              step="0.01"
              value={controlValues.bandContrast}
              ref={(el) => (inputRefs.current[4] = el)}
              onKeyDown={(e) => handleKeyDown(e, 4)}
              onChange={(e) =>
                updateControlValues({
                  type: "SET_BAND_CONTRAST",
                  payload: parseFloat(e.target.value),
                })
              }
            />
          </label>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
          <label>band offset: {controlValues.bandOffset.toFixed(2)}</label>
          <div
            style={{
              display: "flex",
              gap: "4px",
              justifySelf: "end",
              alignSelf: "end",
              height: "1.2rem",
            }}
          >
            <button
              onClick={() =>
                updateControlValues({
                  type: "SET_BAND_DIRECTION",
                  payload: AnimateDirection.Backward,
                })
              }
              disabled={controlValues.bandDirection != AnimateDirection.Forward}
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
          </div>
          <input
            style={{ gridColumn: "span 2", opacity: "60%" }}
            type="range"
            id="bandOffset"
            min="-3.14"
            max="3.14"
            step="0.01"
            list="zeroMarker"
            value={controlValues.bandOffset}
            ref={(el) => (inputRefs.current[5] = el)}
            onKeyDown={(e) => handleKeyDown(e, 5)}
            onChange={(e) =>
              updateControlValues({
                type: "SET_BAND_OFFSET",
                payload: parseFloat(e.target.value),
              })
            }
          />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
          <label>hue offset: {controlValues.hueOffset.toFixed(0)}</label>
          <div
            style={{
              height: "1.2rem",
              display: "flex",
              gap: "4px",
              justifySelf: "end",
              alignSelf: "end",
            }}
          >
            <button
              onClick={() =>
                updateControlValues({
                  type: "SET_HUE_DIRECTION",
                  payload: AnimateDirection.Backward,
                })
              }
              disabled={controlValues.hueDirection != AnimateDirection.Forward}
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
              disabled={controlValues.hueDirection != AnimateDirection.Backward}
            >
              &gt;
            </button>
          </div>
          <input
            style={{ gridColumn: "span 2", opacity: "60%" }}
            type="range"
            id="hueOffset"
            min="-180"
            max="179"
            step="1"
            list="zeroMarker"
            value={controlValues.hueOffset}
            ref={(el) => (inputRefs.current[6] = el)}
            onKeyDown={(e) => handleKeyDown(e, 6)}
            onChange={(e) =>
              updateControlValues({
                type: "SET_HUE_OFFSET",
                payload: parseFloat(e.target.value),
              })
            }
          />
        </div>
        <div>
          <label>
            saturation: {controlValues.saturation}
            <input
              type="range"
              id="saturation"
              min="0"
              max="2"
              step="0.01"
              value={controlValues.saturation}
              list="oneMarker"
              ref={(el) => (inputRefs.current[7] = el)}
              onKeyDown={(e) => handleKeyDown(e, 7)}
              onChange={(e) =>
                updateControlValues({
                  type: "SET_SATURATION",
                  payload: parseFloat(e.target.value),
                })
              }
            />
          </label>
        </div>
        <div>
          <label>
            lightness: {controlValues.lightness}
            <input
              type="range"
              id="lightness"
              min="0"
              max="2"
              step="0.01"
              value={controlValues.lightness}
              list="oneMarker"
              ref={(el) => (inputRefs.current[8] = el)}
              onKeyDown={(e) => handleKeyDown(e, 8)}
              onChange={(e) =>
                updateControlValues({
                  type: "SET_LIGHTNESS",
                  payload: parseFloat(e.target.value),
                })
              }
            />
          </label>
        </div>
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
