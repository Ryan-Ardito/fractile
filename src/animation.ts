import { useState } from "react";
import { layer } from "./map";

const [bandOffset, setBandOffset] = useState(0);
const [bandSpeed, setBandSpeed] = useState(1);
const [hueOffset, setHueOffset] = useState(0);
const [hueSpeed, setHueSpeed] = useState(1);

const [animationSpeed, setAnimationSpeed] = useState(5);
let animatingColor = false;
let prevFrameTime: number | null = null;

const animateColor: FrameRequestCallback = (timestamp) => {
  const frameDuration = 1000 / 2 ** animationSpeed;

  if (!prevFrameTime) prevFrameTime = timestamp;
  const elapsed = timestamp - prevFrameTime;
  prevFrameTime = timestamp;
  const framesPassed = elapsed / frameDuration;

  const bandStep = (Math.PI / 60) * bandSpeed * framesPassed;
  setBandOffset(bandOffset + bandStep);
  if (bandOffset > Math.PI) {
    setBandOffset(bandOffset - Math.PI * 2);
  }
  layer.updateStyleVariables({ ["bandOffset"]: bandOffset });

  const hueStep = hueSpeed * framesPassed;
  setHueOffset(hueOffset - hueStep);
  if (hueOffset < -180) {
    setHueOffset(hueOffset + 360);
  }
  layer.updateStyleVariables({ ["hueOffset"]: hueOffset });

  const hueInput = document.getElementById("hueOffset") as HTMLInputElement;
  const hueLabel = hueInput.previousElementSibling;
  if (hueInput && hueLabel) {
    const adjHue = Math.round(hueOffset);
    hueInput.value = adjHue.toString();
    hueLabel.textContent = adjHue.toString();
  }

  const bandOffsetInput = document.getElementById(
    "bandOffset"
  ) as HTMLInputElement;
  const bandOffsetLabel = bandOffsetInput.previousElementSibling;
  if (bandOffsetInput && bandOffsetLabel) {
    const adjBandOffset = (bandOffset / Math.PI).toFixed(2).toString();
    bandOffsetInput.value = adjBandOffset;
    bandOffsetLabel.textContent = adjBandOffset;
  }

  if (animatingColor) {
    requestAnimationFrame(animateColor);
  } else {
    prevFrameTime = null;
  }
};

export const startAnimation = () => {
  animatingColor = true;
  requestAnimationFrame(animateColor);
  const animateButton = document.getElementById("animateButton");
  if (animateButton) {
    animateButton.textContent = "stop";
  }
};

export const stopAnimation = () => {
  animatingColor = false;
  const animateButton = document.getElementById("animateButton");
  if (animateButton) {
    animateButton.textContent = "animate";
  }
};

export const toggleAnimation = () => {
  if (!animatingColor) {
    startAnimation();
  } else {
    stopAnimation();
  }
};

const animateButton = document.getElementById("animateButton");
if (animateButton) {
  animateButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!animatingColor) {
      startAnimation();
    } else {
      stopAnimation();
    }
  });
}
