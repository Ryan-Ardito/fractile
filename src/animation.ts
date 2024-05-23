import { layer } from "./map";

let animatingColor = false;
let bandOffset = 0;
let bandSpeed = 1;
let hueOffset = 0;
let hueSpeed = 1;

let prevFrameTime: number | null = null;
let animationSpeed = 5;

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

const startAnimation = () => {
  if (animatingColor) {
    return;
  }

  animatingColor = true;
  requestAnimationFrame(animateColor);
  const animateButton = document.getElementById("animateButton");
  if (animateButton) {
    animateButton.textContent = "stop";
  }
};

const stopAnimation = () => {
  animatingColor = false;
  const animateButton = document.getElementById("animateButton");
  if (animateButton) {
    animateButton.textContent = "animate";
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
