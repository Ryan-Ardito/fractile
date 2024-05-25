// import { view } from "./map";
// import {
//   toggleAnimation,
// } from "./animation";

// const BASE_NUDGE = 156543.03392804096;

// const wakeTime = 1000;
// let timeout: number;

// const hideMouseCursor = () => {
//   if (document.body.style.cursor !== "none") {
//     document.body.style.cursor = "none";
//   }
// };

// const showMouseCursor = () => {
//   clearTimeout(timeout);
//   if (document.body.style.cursor !== "default") {
//     document.body.style.cursor = "default";
//   }
// };

// document.onmousemove = () => {
//   showMouseCursor();
//   timeout = setTimeout(hideMouseCursor, wakeTime);
// };

// document.onmousedown = () => {
//   showMouseCursor();
//   timeout = setTimeout(hideMouseCursor, wakeTime);
// };

// document.addEventListener("DOMContentLoaded", () => {
//   document.addEventListener("keydown", (event) => {

//     if (event.key === "Escape" || event.key === "Esc") {
//       const menuButton = document.getElementById("menuButton");
//       const floatingBox = document.getElementById("floatingBox");
//       if (floatingBox && menuButton) {
//         floatingBox.style.visibility = "collapse";
//         floatingBox.style.opacity = "0%";
//         menuButton.textContent = "menu";
//       }
//     }
//   });
// });
