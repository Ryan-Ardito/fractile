import { Menu } from "./components/Menu";
import { AboutInfo } from "./components/AboutInfo";
import { MapComponent } from "./components/Map";
import { useAppContext } from "./AppContext";
import { useEffect } from "react";

const BASE_NUDGE = 156543.03392804096;

function App() {
  const { fractalMap, setControlValues } = useAppContext();

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const mapView = fractalMap.current?.getView();
      const zoom = mapView?.getZoom();

      if (!mapView || !zoom) {
        return;
      }

      switch (event.key) {
        case " ":
          event.preventDefault();
          setControlValues((vals) => {
            return {
              ...vals,
              animatingColor: !vals.animatingColor,
            };
          });
          break;
        case "ArrowUp":
          mapView.adjustCenter([0, BASE_NUDGE / Math.pow(2, zoom)]);
          break;
        case "ArrowDown":
          mapView.adjustCenter([0, (-1 * BASE_NUDGE) / Math.pow(2, zoom)]);
          break;
        case "ArrowRight":
          mapView.adjustCenter([BASE_NUDGE / Math.pow(2, zoom), 0]);
          break;
        case "ArrowLeft":
          mapView.adjustCenter([(-1 * BASE_NUDGE) / Math.pow(2, zoom), 0]);
          break;
      }
    };

    document.addEventListener("keydown", handleKey);
  }, []);

  return (
    <>
      <MapComponent />
      <Menu />
      <AboutInfo />
    </>
  );
}

export default App;
