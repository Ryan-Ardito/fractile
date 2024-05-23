import { View } from "ol";
import { Extent } from "ol/extent";
import { useEffect, useRef } from "react";
import DataTile from "ol/source/DataTile";
import Map from "ol/Map";
import TileLayer from "ol/layer/WebGLTile";
import { colorPixelExpression } from "../colorGL";
import { Coordinate } from "ol/coordinate";
import { useAppContext } from "../AppContext";

const TILE_SIZE = 256;
const BASE_ITERATIONS = 1024;
const BASE_NUDGE = 156543.03392804096;
const extent: Extent = [-30000000, -15000000, 30000000, 15000000];

const loadTile = (z: number, x: number, y: number): Promise<Uint8Array> => {
  return new Promise((resolve, reject) => {
    // hacky black real line fix
    z += 1e-9;

    const worker = new Worker(
      new URL("../mandelbrotWorker.ts", import.meta.url)
    );

    worker.onmessage = (e) => {
      const data = e.data;
      worker.terminate();
      resolve(data);
    };

    worker.onerror = (error) => {
      worker.terminate();
      reject(error);
    };

    worker.postMessage({
      z,
      x,
      y,
      size: TILE_SIZE,
      iterations: BASE_ITERATIONS * z,
    });
  });
};

export const MapComponent = () => {
  const {
    fractalMap,
    setFractalMap,
    animatingColor,
    setAnimatingColor,
    bandContrast,
    bandOffset,
    bandSpacing,
    paletteScale,
    hueOffset,
    saturation,
    lightness,
  } = useAppContext();
  const mapElement = useRef<Map | undefined>(undefined);
  const mapRef = useRef<Map | undefined>(undefined);
  mapRef.current = fractalMap;

  const zoom = 4;
  const center: Coordinate = [-1200000, 0];

  const view = new View({
    multiWorld: true,
    extent,
    minZoom: 3,
    maxZoom: 42,
    enableRotation: false,
    center,
    zoom,
  });

  const layer = new TileLayer({
    style: {
      color: colorPixelExpression(),
      variables: {
        iterFalloff: 24,
        paletteScale,
        hueOffset,
        bandSpacing,
        bandContrast,
        bandOffset,
        saturation,
        lightness,
      },
    },
    extent,
    preload: Infinity,
    source: new DataTile({
      // interpolate: true,
      bandCount: 1,
      transition: 0,
      tileSize: TILE_SIZE,
      loader: loadTile,
    }),
  });

  const map = new Map({
    pixelRatio: window.devicePixelRatio,
    maxTilesLoading: navigator.hardwareConcurrency,
    target: "map",
    controls: [],
    layers: [layer],
    view,
  });

  useEffect(() => {
    return () => map.setTarget(undefined);
  }, []);

  document.addEventListener("keydown", (event) => {
    switch (event.key) {
      case " ":
        event.preventDefault();
        if (animatingColor) {
          setAnimatingColor(false);
        } else {
          setAnimatingColor(false);
        }
        break;
      case "ArrowUp":
        view.adjustCenter([0, BASE_NUDGE / Math.pow(2, zoom)]);
        break;
      case "ArrowDown":
        view.adjustCenter([0, (-1 * BASE_NUDGE) / Math.pow(2, zoom)]);
        break;
      case "ArrowRight":
        view.adjustCenter([BASE_NUDGE / Math.pow(2, zoom), 0]);
        break;
      case "ArrowLeft":
        view.adjustCenter([(-1 * BASE_NUDGE) / Math.pow(2, zoom), 0]);
        break;
    }
  });

  useEffect(() => {
    const adjPaletteScale = 2 ** (paletteScale - 5);
    layer.updateStyleVariables({ ["paletteScale"]: adjPaletteScale });
  }, [paletteScale]);

  useEffect(() => {
    const adjBandSpacing = 2 ** bandSpacing;
    layer.updateStyleVariables({ ["bandSpacing"]: adjBandSpacing });
  }, [bandSpacing]);

  useEffect(() => {
    layer.updateStyleVariables({ ["bandContrast"]: bandContrast });
    console.log("in useEffect");
  }, [bandContrast]);

  useEffect(() => {
    layer.updateStyleVariables({ ["hueOffset"]: hueOffset });
  }, [hueOffset]);

  useEffect(() => {
    const adjBandOffset = bandOffset * Math.PI;
    layer.updateStyleVariables({ ["bandOffset"]: adjBandOffset });
  }, [bandOffset]);

  useEffect(() => {
    layer.updateStyleVariables({ ["saturation"]: saturation });
  }, [saturation]);

  useEffect(() => {
    layer.updateStyleVariables({ ["lightness"]: lightness });
  }, [lightness]);

  return (
    <div
      id="map"
      style={{ height: "100vh", width: "100%" }}
      className="map-container"
    />
  );
};
