import { Menu } from "./components/Menu";
import { AboutInfo } from "./components/AboutInfo";
import { MapComponent } from "./components/Map";
import { AppProvider } from "./AppContext";

function App() {
  return (
    <AppProvider>
      <Menu />
      <AboutInfo />
      <MapComponent />
    </AppProvider>
  );
}

export default App;
