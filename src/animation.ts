import { layer } from "./map";

let animatingColor = false;
export let bandOffset = 0;
export let bandSpeed = 1;
export let hueOffset = 0;
export let hueSpeed = 1;

let prevFrameTime: number | null = null;
let animationSpeed = 5;

export const setAnimationSpeed = (speed: number) => {
  animationSpeed = speed;
};

export const setBandSpeed = (speed: number) => {
  bandSpeed = speed;
};

export const setHueSpeed = (speed: number) => {
  hueSpeed = speed;
};

export const setHueOffset = (speed: number) => {
  hueOffset = speed;
};

export const setBandOffset = (speed: number) => {
  hueOffset = speed;
};

const animateColor: FrameRequestCallback = (timestamp) => {
  const frameDuration = 1000 / 2 ** animationSpeed;

  if (!prevFrameTime) prevFrameTime = timestamp;
  const elapsed = timestamp - prevFrameTime;
  prevFrameTime = timestamp;
  const framesPassed = elapsed / frameDuration;

  const bandStep = (Math.PI / 60) * bandSpeed * framesPassed;
  bandOffset += bandStep;
  if (bandOffset > Math.PI) {
    bandOffset -= Math.PI * 2;
  }
  layer.updateStyleVariables({ ["bandOffset"]: bandOffset });

  const hueStep = hueSpeed * framesPassed;
  hueOffset -= hueStep;
  if (hueOffset < -180) {
    hueOffset += 360;
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
