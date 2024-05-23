import { useEffect } from "react";
import { map } from "../map";

export const MapComponent = () => {
  useEffect(() => {
    return () => map.setTarget("map");
  }, []);

  return <div id="map" className="map" />;
};
