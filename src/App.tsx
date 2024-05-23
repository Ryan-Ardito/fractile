import { Menu } from "./Menu";
import { AboutInfo } from "./components/AboutInfo";
import { MapComponent } from "./components/Map";

function App() {
  return (
    <>
      <MapComponent />
      <Menu />
      <AboutInfo />
    </>
  );
}

export default App;
