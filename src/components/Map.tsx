import { useEffect, useRef } from "react";
import { FractalViewer } from "../engine/viewer";
import { useAppContext } from "../AppContext";

export const MapComponent = () => {
  const { viewer } = useAppContext();
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const v = new FractalViewer(containerRef.current, window.location.hash);
    viewer.current = v;
    return () => {
      v.destroy();
      viewer.current = undefined;
    };
  }, []);

  return (
    <div
      id="map"
      ref={containerRef}
      style={{ height: "100vh", width: "100%" }}
      className="map-container"
    />
  );
};
