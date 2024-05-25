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
  const { fractalMap, tileLayer, controlValues, setControlValues } =
    useAppContext();

  const prevFrameTime = useRef<number | undefined>(undefined);
  const controlValuesRef = useRef(controlValues);

  useEffect(() => {
    controlValuesRef.current = controlValues;
  }, [controlValues]);

  const animateColor: FrameRequestCallback = (timestamp) => {
    const frameDuration = 1000 / 2 ** controlValuesRef.current.animationSpeed;

    if (!prevFrameTime.current) {
      prevFrameTime.current = timestamp;
    }
    const elapsed = timestamp - prevFrameTime.current;
    prevFrameTime.current = timestamp;
    const framesPassed = elapsed / frameDuration;

    const bandStep =
      (Math.PI / 60) * controlValuesRef.current.bandSpeed * framesPassed;
    let newBandOffset =
      controlValuesRef.current.bandOffset * Math.PI + bandStep;
    if (newBandOffset > Math.PI) {
      newBandOffset -= Math.PI * 2;
    }
    setControlValues({
      ...controlValuesRef.current,
      bandOffset: newBandOffset / Math.PI,
    });

    const hueStep = controlValuesRef.current.hueSpeed * framesPassed;
    let newHueOffset = controlValuesRef.current.hueOffset - hueStep;
    if (controlValuesRef.current.hueOffset < -180) {
      newHueOffset += 360;
    }
    setControlValues({ ...controlValuesRef.current, hueOffset: newHueOffset });

    if (controlValuesRef.current.animatingColor) {
      requestAnimationFrame(animateColor);
    } else {
      prevFrameTime.current = undefined;
    }
  };

  useEffect(() => {
    if (controlValues.animatingColor) {
      requestAnimationFrame(animateColor);
    }
    return () => {
      if (prevFrameTime.current !== undefined) {
        cancelAnimationFrame(prevFrameTime.current);
        prevFrameTime.current = undefined;
      }
    };
  }, [controlValues.animatingColor]);

  useEffect(() => {
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
          paletteScale: 5,
          hueOffset: 0,
          bandSpacing: 3,
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
