import { Menu } from "./components/Menu";
import { AboutInfo } from "./components/AboutInfo";
import { MapComponent } from "./components/Map";
import { useAppContext } from "./AppContext";
import { useEffect, useRef } from "react";

const MOUSE_HIDE_DELAY = 1000;

function App() {
  const { viewer, animationValues, controlValues, updateControlValues } =
    useAppContext();
  const prevFrameTime = useRef<number | undefined>();
  const frameId = useRef<number | undefined>();
  const timeout = useRef<number | undefined>();

  useEffect(() => {
    const hideMouseCursor = () => {
      if (document.body.style.cursor !== "none") {
        document.body.style.cursor = "none";
      }
    };

    const showMouseCursor = () => {
      clearTimeout(timeout.current);
      if (document.body.style.cursor !== "default") {
        document.body.style.cursor = "default";
      }
    };

    const handleWakeUp = () => {
      showMouseCursor();
      timeout.current = setTimeout(hideMouseCursor, MOUSE_HIDE_DELAY);
    };

    document.addEventListener("mousemove", handleWakeUp);
    document.addEventListener("mousedown", handleWakeUp);

    return () => {
      document.removeEventListener("mousemove", handleWakeUp);
      document.removeEventListener("mousedown", handleWakeUp);
    };
  }, []);

  const animateColor: FrameRequestCallback = (timestamp) => {
    if (!prevFrameTime.current) {
      prevFrameTime.current = timestamp;
    }
    const elapsed = timestamp - prevFrameTime.current;
    prevFrameTime.current = timestamp;
    const frameDuration = animationValues.current.frameDuration;
    const framesPassed = elapsed / frameDuration;
    const bandHueSpeed = animationValues.current.bandHueSpeed;

    const bandDirection = animationValues.current.bandDirection;
    const bandSpeed = Math.min(1, (1 - bandHueSpeed) * 2);
    const bandStep = Math.PI * bandSpeed * framesPassed;
    const bandOffset = animationValues.current.bandOffset;
    let newBandOffset =
      bandOffset + bandStep * animationValues.current.bandDirection;
    if (Math.abs(newBandOffset) > Math.PI) {
      newBandOffset -= Math.PI * 2 * bandDirection;
      newBandOffset %= Math.PI;
    }

    const hueDirection = animationValues.current.hueDirection;
    const hueSpeed = Math.min(1, bandHueSpeed * 2);
    const hueStep = 90 * hueSpeed * framesPassed;
    const hueOffset = animationValues.current.hueOffset;
    let newHueOffset = hueOffset + hueStep * hueDirection;
    if (Math.abs(newHueOffset) > 180) {
      newHueOffset -= 360 * hueDirection;
      newHueOffset %= 180;
    }

    animationValues.current.bandOffset = newBandOffset;
    animationValues.current.hueOffset = newHueOffset;
    updateControlValues({
      type: "UPDATE_ANIMATION",
      payload: { newBandOffset, newHueOffset },
    });

    if (animationValues.current.isAnimating) {
      frameId.current = requestAnimationFrame(animateColor);
    } else {
      prevFrameTime.current = undefined;
      frameId.current = undefined;
    }
  };

  useEffect(() => {
    if (controlValues.isAnimating) {
      frameId.current = requestAnimationFrame(animateColor);
    }
    return () => {
      if (frameId.current) {
        cancelAnimationFrame(frameId.current);
        prevFrameTime.current = undefined;
        frameId.current = undefined;
      }
    };
  }, [controlValues.isAnimating]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const menuCollapsed = controlValues.menuCollapsed;
      if (!viewer.current || !menuCollapsed) {
        return;
      }
      switch (event.key) {
        case "ArrowUp":
          viewer.current.panPixels(0, -1);
          break;
        case "ArrowDown":
          viewer.current.panPixels(0, 1);
          break;
        case "ArrowRight":
          viewer.current.panPixels(1, 0);
          break;
        case "ArrowLeft":
          viewer.current.panPixels(-1, 0);
          break;
      }
    };

    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
    };
  }, [controlValues.menuCollapsed]);

  const shouldUpdate = useRef(false);
  useEffect(() => {
    const v = viewer.current;
    if (!v) return;

    const updatePermalink = () => {
      if (!shouldUpdate.current) {
        shouldUpdate.current = true;
        return;
      }
      const hash = v.getHash();
      window.history.replaceState({ hash }, "map", hash);
    };

    const handleHashChange = (e: HashChangeEvent) => {
      try {
        const url = e.newURL;
        const hash = url.substring(url.indexOf("#"));
        v.applyHash(hash);
        window.history.replaceState({ hash }, "map", hash);
      } catch {}
    };

    const handlePopState = (e: PopStateEvent) => {
      if (e.state === null || !e.state.hash) {
        return;
      }
      try {
        v.applyHash(e.state.hash);
      } catch {}
      shouldUpdate.current = false;
    };

    const handleKey = (event: KeyboardEvent) => {
      switch (event.key) {
        case " ":
          event.preventDefault();
          updateControlValues({ type: "TOGGLE_ANIMATING" });
          break;

        case "Escape":
          updateControlValues({ type: "SET_MENU_COLLAPSED", payload: true });
      }
    };

    v.on("moveend", updatePermalink);
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("hashchange", handleHashChange);
    document.addEventListener("keydown", handleKey);
    return () => {
      v.off("moveend", updatePermalink);
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("hashchange", handleHashChange);
      document.removeEventListener("keydown", handleKey);
    };
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
