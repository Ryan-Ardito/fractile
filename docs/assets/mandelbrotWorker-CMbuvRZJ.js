(function(){"use strict";const I=(f,d,p,t)=>{const e=new Uint8Array(t*t*4),l=Math.pow(2,-f)*4,T=-2+d*l,u=-2+p*l;for(let c=0;c<t;c++)for(let s=0;s<t;s++){let n=0,o=0,b=T+c*l/t,g=u+s*l/t,a=0;for(;n*n+o*o<4&&a<1024;){let S=n*n-o*o+b;o=2*n*o+g,n=S,a++}a=a%1024;const x=a/100*255|0;let h=x%8*32,i=x%16*16,y=x%32*8,A=255;const r=(s*t+c)*4;e[r]=h,e[r+1]=i,e[r+2]=y,e[r+3]=A}return e};onmessage=f=>{const{z:d,x:p,y:t,size:e}=f.data,l=I(d,p,t,e);postMessage(l)}})();
//# sourceMappingURL=mandelbrotWorker-CMbuvRZJ.js.map
