import { View } from "ol";
import { Extent } from "ol/extent";
import DataTile from "ol/source/DataTile";
import Map from "ol/Map";
import TileLayer from "ol/layer/WebGLTile";
import { colorPixelExpression } from "../colorGL";
import { Coordinate } from "ol/coordinate";
import { useEffect } from "react";

import { useAppContext } from "../AppContext";

const TILE_SIZE = 256;
const BASE_ITERATIONS = 1024;

export const locationFromHash = (hash: string): [number, Coordinate] => {
  const trim_hash = hash.replace("#map=", "");
  const parts = trim_hash.split("/");
  if (parts.length === 3) {
    const zoom = parseFloat(parts[0]);
    const center: Coordinate = [parseFloat(parts[1]), parseFloat(parts[2])];
    return [zoom, center];
  } else {
    throw new Error("invalid location hash");
  }
};

const loadTile = (z: number, x: number, y: number): Promise<Float32Array> => {
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
  const { fractalMap, tileLayer, controlValues } = useAppContext();
  const {
    paletteScale,
    bandSpacing,
    bandContrast,
    hueOffset,
    bandOffset,
    saturation,
    lightness,
  } = controlValues;

  useEffect(() => {
    if (tileLayer.current) {
      const adjPaletteScale = 1 / 2 ** (paletteScale - 5);
      const adjBandSpacing = 1 / 2 ** bandSpacing;
      const adjBandOffset = bandOffset * Math.PI;

      tileLayer.current.updateStyleVariables({
        paletteScale: adjPaletteScale,
        bandSpacing: adjBandSpacing,
        bandContrast,
        hueOffset,
        bandOffset: adjBandOffset,
        saturation,
        lightness,
      });
    }
  }, [
    paletteScale,
    bandSpacing,
    bandContrast,
    hueOffset,
    bandOffset,
    saturation,
    lightness,
  ]);

  useEffect(() => {
    const extent: Extent = [-30000000, -15000000, 30000000, 15000000];
    let zoom = 4;
    let center: Coordinate = [-1200000, 0];
    if (window.location.hash) {
      try {
        [zoom, center] = locationFromHash(window.location.hash);
      } catch {}
    }

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
          iterFalloff: 1 / 24,
          paletteScale: 1,
          hueOffset: 0,
          bandSpacing: 1 / 8,
          bandContrast: 0.28,
          bandOffset: 0,
          saturation: 0.8,
          lightness: 1,
        },
      },
      extent,
      preload: Infinity,
      source: new DataTile({
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

    tileLayer.current = layer;
    fractalMap.current = map;

    return () => {
      map.setTarget(undefined);
      fractalMap.current = undefined;
    };
  }, []);

  return (
    <div
      id="map"
      style={{ height: "100vh", width: "100%" }}
      className="map-container"
    />
  );
};
