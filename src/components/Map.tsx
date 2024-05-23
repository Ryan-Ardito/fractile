import { View } from "ol";
import { Extent } from "ol/extent";
import { useEffect } from "react";
import DataTile from "ol/source/DataTile";
import Map from "ol/Map";
import TileLayer from "ol/layer/WebGLTile";
import { colorPixelExpression } from "../colorGL";
import { Coordinate } from "ol/coordinate";
import { useAppContext } from "../AppContext";

const TILE_SIZE = 256;
const BASE_ITERATIONS = 1024;
const extent: Extent = [-30000000, -15000000, 30000000, 15000000];

const loadTile = (z: number, x: number, y: number): Promise<Uint8Array> => {
  return new Promise((resolve, reject) => {
    // hacky black real line fix
    z += 1e-9;

    const worker = new Worker(
      new URL("./mandelbrotWorker.ts", import.meta.url)
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
    bandContrast,
    setBandContrast,
    bandOffset,
    setBandOffset,
    bandSpacing,
    setBandSpacing,
    paletteScale,
    setPaletteScale,
    hueOffset,
    setHueOffset,
    saturation,
    setSaturation,
    lightness,
    setLightness,
  } = useAppContext();

  const zoom = 4;
  const center: Coordinate = [-1200000, 0];
  useEffect(() => {
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
          paletteScale: 1,
          hueOffset: 0,
          bandSpacing: 8,
          bandContrast: 0.28,
          bandOffset: 0,
          saturation: 0.8,
          lightness: 1,
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
      const adjPaletteScale = 2 ** (paletteScale - 5);
      layer.updateStyleVariables({ ["paletteScale"]: adjPaletteScale });
    }, [paletteScale]);

    useEffect(() => {
      const adjBandSpacing = 2 ** bandSpacing;
      layer.updateStyleVariables({ ["bandSpacing"]: adjBandSpacing });
    }, [bandSpacing]);

    useEffect(() => {
      layer.updateStyleVariables({ ["hueOffset"]: hueOffset });
    }, [hueOffset]);

    useEffect(() => {
      const adjBandOffset = bandOffset * Math.PI;
      layer.updateStyleVariables({ ["bandOffset"]: adjBandOffset });
    }, [bandOffset]);

    return () => map.setTarget("map");
  }, []);

  return <div id="map" className="map" />;
};
