"use strict";
/*
 * JOYA AI core D, "Mesh" (approved mockup ai-core-v4, 2026-10-06): a sphere
 * made of dots -- a fine lat/long grid drawn as rows of dots with brighter
 * points at the crossings -- whose surface folds and wobbles like a liquid,
 * coloured cyan -> electric blue -> violet -> magenta across the screen, with
 * a glow hugging the silhouette (hot magenta lower right, electric blue upper
 * left) and a halo of fine dots just outside it.
 *
 * States, all in the mesh itself (weights eased over ~1 s; every motion an
 * accumulated phase, so nothing jumps):
 *   idle        slow rotation; the folds drift and breathe
 *   listening   ripples travel in toward the front with the voice level; the halo draws in
 *   thinking    the folds deepen and twist round the vertical axis; the gradient turns
 *   delegating  a stream of dots peels off the side facing the session and flows to it
 *   speaking    each syllable swells a ring out from the front centre; the halo is pushed out
 *   needs       the rim warms to amber with a slow double pulse
 *
 * Same instance contract as joya-core.js (cc-map.js swaps between them):
 *   var core = window.JoyaCoreD(canvas, { amp, dest, onFrame, backdrop, showTarget, force2d, noGuard })
 *   core.S.concept === "D" · setState · setConcept (no-op) · setLight · resize(cx, cy, R, w, h)
 *   · start · stop · still · stats · draw · destroy
 * opts.kids(): the Command Center's session spheres (cc-family.js) as small mesh
 * replicas, all drawn here in one batch; opts.beforeDraw(S, W) runs after the
 * step and before the draw (the family moves first, so meshes and names agree).
 * backdrop: "glow" (default) leaves the canvas transparent and paints only the
 * navy -> purple (dark) or lavender (light) glow round the core, so the page's
 * own background shows elsewhere; "full" paints the whole canvas; "none" no
 * glow at all (the dock's small canvas).
 *
 * WebGL2 (gl_VertexID); without it a Canvas-2D wireframe. DPR <= 2; the loop
 * stops while the tab is hidden; prefers-reduced-motion draws one still frame
 * per change; frames slower than ~45 fps for 2 s drop to 0.7x resolution once.
 * No eval, no inline style: CSP-safe.
 */
(function () {
  if (typeof window === "undefined") return;
  var STATES = ["idle", "listening", "thinking", "delegating", "speaking", "needs"];
  var KEYS = ["listen", "think", "speak", "deleg", "need"];
  var TARGETS = {
    idle: {}, listening: { listen: 1 }, thinking: { think: 1 },
    delegating: { deleg: 1 }, speaking: { speak: 1 }, needs: { need: 1 },
  };
  var HALO = 4200, STREAM = 900, TGT = 160, NSPR = HALO + STREAM + TGT;

  function synthAmp(t) {
    var phrase = Math.sin(t * 0.9) * 0.5 + 0.5 > 0.18 ? 1 : 0.1;
    var syl = Math.abs(Math.sin(t * 7.3) * Math.sin(t * 3.1 + 1.2));
    return Math.min(1, (0.18 + 0.75 * syl + 0.12 * Math.sin(t * 17.0)) * phrase);
  }
  function synthListen(t) {
    var phrase = Math.sin(t * 0.7 + 2.0) * 0.5 + 0.5 > 0.3 ? 1 : 0.08;
    var syl = Math.abs(Math.sin(t * 5.9 + 0.4) * Math.sin(t * 2.3));
    return Math.min(1, (0.1 + 0.8 * syl) * phrase);
  }

  var NOISE = [
    "vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}",
    "vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}",
    "vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}",
    "vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}",
    "float snoise(vec3 v){",
    " const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);",
    " vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);",
    " vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);",
    " vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;",
    " i=mod289(i);",
    " vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));",
    " float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;",
    " vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);",
    " vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);",
    " vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);",
    " vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));",
    " vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;",
    " vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);",
    " vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));",
    " p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;",
    " vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;",
    " return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));",
    "}",
  ].join("\n");

  /* shared: uniforms, palette, the displaced surface and the projection */
  var COMMON = [
    "uniform vec2 u_res,u_c; uniform float u_R,u_t,u_flow,u_rot,u_amp,u_light,u_beat,u_grad,u_ripple,u_tw,u_psz;",
    "uniform float u_listen,u_think,u_speak,u_deleg,u_need;",
    "uniform vec3 u_T; uniform vec4 u_rings,u_ringAmp;",
    "#define PI 3.14159265",
    NOISE,
    "vec3 rotY(vec3 v,float a){float c=cos(a),s=sin(a);return vec3(c*v.x+s*v.z,v.y,-s*v.x+c*v.z);}",
    "vec3 rotX(vec3 v,float a){float c=cos(a),s=sin(a);return vec3(v.x,c*v.y-s*v.z,s*v.y+c*v.z);}",
    /* cyan -> electric blue -> violet -> magenta, k in 0..1 */
    "vec3 gradD(float k){",
    " vec3 c0=vec3(0.10,0.82,1.0), c1=vec3(0.22,0.42,1.0), c2=vec3(0.56,0.26,1.0), c3=vec3(1.0,0.26,0.82);",
    " return k<0.34?mix(c0,c1,k/0.34):k<0.67?mix(c1,c2,(k-0.34)/0.33):mix(c2,c3,(k-0.67)/0.33);",
    "}",
    "vec3 gradL(float k){",
    " vec3 c0=vec3(0.0,0.50,0.78), c1=vec3(0.10,0.30,0.86), c2=vec3(0.54,0.17,0.89), c3=vec3(0.80,0.10,0.55);",
    " return k<0.34?mix(c0,c1,k/0.34):k<0.67?mix(c1,c2,(k-0.34)/0.33):mix(c2,c3,(k-0.67)/0.33);",
    "}",
    "vec2 gdir(){ return vec2(cos(u_grad),sin(u_grad)); }",
    "float gk(vec2 sp){ return clamp(dot(sp,gdir())*0.58+0.56,0.0,1.0); }",
    "float ringSum(float fr){ float s=0.0; for(int i=0;i<4;i++){ float a=u_rings[i]; if(a<1.0){ float rho=a*2.4; s+=u_ringAmp[i]*(1.0-a)*exp(-pow((fr-rho)/0.22,2.0)); } } return s; }",
    /* displacement along the normal */
    "float disp(vec3 w,vec3 v){",
    " vec3 q=rotY(w,u_think*(0.9+0.6*u_tw)*w.y);",            // torsion of the folds round the vertical axis
    " float A=0.095+0.05*u_think+0.010*sin(u_t*0.9);",
    " float n=snoise(q*1.9+vec3(0.0,u_flow,u_flow*0.6))*0.82+snoise(q*3.2-vec3(u_flow*0.9,0.0,u_flow*0.4))*0.18;",
    " float d=A*n+0.012*sin(u_t*1.1);",
    " float fr=acos(clamp(v.z,-1.0,1.0));",                   // angle from the front centre
    " d+=u_listen*(0.006+0.030*u_amp)*sin(fr*13.0+u_ripple)*smoothstep(1.9,0.2,fr);",
    " d+=0.10*ringSum(fr);",
    " d+=u_deleg*0.05*pow(max(dot(v,u_T),0.0),2.0)-u_deleg*0.02;",          // the tendril toward the session
    " return d;",
    "}",
    "vec3 dirOf(vec2 uv){ float th=uv.x*PI, ph=uv.y*2.0*PI; return vec3(sin(th)*cos(ph),cos(th),sin(th)*sin(ph)); }",
    "vec3 toView(vec3 w){ return rotX(rotY(w,u_rot),0.14); }",
    "vec2 proj(vec3 p){ float s=3.6/(3.6-p.z); return u_c+p.xy*s*u_R*0.92; }",
    "vec4 clip(vec2 px){ return vec4(px/u_res*2.0-1.0,0.0,1.0); }",
    /* one vertex of the surface: screen position, depth, fresnel, gradient key */
    "float glowR=0.0;",
    "void surf(vec2 uv,out vec2 px,out float z,out float fres,out float k){",
    " vec3 w=dirOf(uv); vec3 v=toView(w);",
    " float d=disp(w,v); vec3 p=v*(1.0+d);",
    " px=proj(p); z=p.z; fres=1.0-abs(v.z); k=gk(p.xy); glowR=ringSum(acos(clamp(v.z,-1.0,1.0)));",
    "}",
    /* colour of the surface at (k,fres,z): rim glow toward the warm side; amber on the rim when it needs you */
    "vec3 surfCol(float k,float fres,bool light){",
    " vec3 c=light?gradL(k):gradD(k);",
    " float nt=u_need*(0.45+0.55*u_beat)*smoothstep(0.35,0.95,fres)*(0.25+0.75*smoothstep(0.3,0.8,k));",
    " c=mix(c,light?vec3(0.80,0.40,0.05):vec3(1.0,0.62,0.28),nt);",
    " return c;",
    "}",
  ].join("\n");

  var BG_VS = "#version 300 es\nin vec2 a_p; void main(){ gl_Position=vec4(a_p,0.0,1.0); }";
  var BG_FS = [
    "#version 300 es",
    "precision highp float;",
    "uniform vec2 u_res,u_c; uniform float u_R,u_light,u_grad,u_need,u_beat,u_speak,u_amp,u_glow;",
    "out vec4 o;",
    "void main(){",
    " vec2 uv=(gl_FragCoord.xy-u_c)/u_R; float rr=length(uv);",
    " float k=clamp(dot(uv,vec2(cos(u_grad),sin(u_grad)))*0.3+0.5,0.0,1.0);",
    " vec3 navy=vec3(0.030,0.045,0.125), purple=vec3(0.150,0.055,0.245), deep=vec3(0.018,0.020,0.050);",
    " vec3 dk=mix(navy,purple,smoothstep(0.15,0.85,k));",
    " dk=mix(dk,deep,smoothstep(0.9,3.4,rr));",
    // a soft glow hugging the silhouette, strongest on the warm side
    " float g=exp(-pow(max(rr-0.90,0.0)/0.22,1.3))*smoothstep(0.55,0.95,rr);",
    " vec3 gc=mix(vec3(0.12,0.38,1.0),vec3(1.0,0.22,0.78),smoothstep(0.25,0.75,k));",
    " gc=mix(gc,vec3(1.0,0.55,0.20),u_need*(0.35+0.4*u_beat));",
    " dk+=gc*g*(0.07+0.60*pow(k,2.2)+0.28*pow(1.0-k,2.5)+0.06*u_speak*u_amp);",
    " vec3 L=vec3(0.972,0.972,0.988);",
    " L=mix(L,vec3(0.92,0.90,0.99),0.7*exp(-rr*rr*0.45));",
    " L=mix(L,mix(vec3(0.82,0.88,1.0),vec3(0.99,0.80,0.93),smoothstep(0.25,0.75,k)),(0.30+0.35*pow(k,2.0)+0.2*pow(1.0-k,2.0))*g);",
    " L=mix(L,vec3(1.0,0.88,0.72),u_need*0.25*g*(0.5+0.5*u_beat));",
    " if(u_glow<0.5){ o=vec4(mix(dk,L,u_light),1.0); return; }",
    // glow only: transparent away from the core, premultiplied
    " float fd=exp(-pow(rr/2.4,2.0));",
    " float ad=clamp(0.82*fd+g*(0.10+0.5*pow(k,2.0)),0.0,0.92);",
    " vec3 cD=mix(dk,gc,clamp(g*(0.25+0.6*pow(k,2.2)+0.3*pow(1.0-k,2.5)),0.0,0.8));",
    " float al=clamp(0.45*exp(-pow(rr/2.0,2.0))+g*(0.18+0.35*pow(k,2.0)+0.18*pow(1.0-k,2.0)),0.0,0.7);",
    " vec3 cL=mix(vec3(0.90,0.88,0.99),mix(vec3(0.80,0.86,1.0),vec3(0.99,0.78,0.92),smoothstep(0.25,0.75,k)),clamp(g*1.4,0.0,1.0));",
    " cL=mix(cL,vec3(1.0,0.85,0.66),u_need*0.5*g*(0.5+0.5*u_beat));",
    " float A=mix(ad,al,u_light);",
    " o=vec4(mix(cD,cL,u_light)*A,A);",
    "}",
  ].join("\n");

  /* mesh: one program for fill, lines and crossing points; u_mode picks the look */
  var MESH_VS = [
    "#version 300 es",
    "precision highp float;",
    "in vec2 a_uv; uniform float u_mode; uniform float u_dens;",
    COMMON,
    "out vec4 v_c; out vec3 v_ink;",
    "void main(){",
    " vec2 px; float z,fres,k; surf(a_uv,px,z,fres,k);",
    " gl_Position=clip(px);",
    " float front=smoothstep(-0.35,0.45,z);",
    " float warm=smoothstep(0.45,1.0,k);",
    " float rim=fres*fres; float pole=smoothstep(0.02,0.30,sin(a_uv.x*PI));",
    " float a; float rg=1.0+1.6*glowR*front;",
    " float r4=rim*rim; float cool=1.0-smoothstep(0.0,0.45,k);",
    " if(u_mode<0.5){ a=0.026+r4*(0.36*warm+0.26*cool+0.05); gl_PointSize=1.0; }",                       // fill
    " else if(u_mode<1.5){ a=(0.20+0.80*front)*(1.0+3.0*rim*warm+2.0*rim*cool+0.6*rim)*u_dens*pole; gl_PointSize=u_psz*0.62*(0.85+0.4*front); }", // lines
    " else { a=(0.08+0.80*front*front)*(1.0+2.0*rim*warm+1.2*rim*cool)*u_dens*pole; gl_PointSize=u_psz*(0.85+0.75*front); }", // crossings
    " vec3 cd=surfCol(k,fres,false), cl=surfCol(k,fres,true);",
    " if(u_mode>1.5) cd=mix(cd,vec3(1.0),0.35*front);",
    " v_c=vec4(cd,clamp(a*rg,0.0,1.0)); v_ink=cl;",
    "}",
  ].join("\n");
  var MESH_FS = [
    "#version 300 es",
    "precision highp float;",
    "in vec4 v_c; in vec3 v_ink; uniform float u_light,u_mode; out vec4 o;",
    "void main(){",
    " float a=v_c.a;",
    " if(u_mode>0.5){ vec2 q=gl_PointCoord*2.0-1.0; float r2=dot(q,q); if(r2>1.0) discard; a*=exp(-r2*(u_mode>1.5?2.5:1.6)); }",
    " float al=a*(u_mode<0.5?0.8:1.25);",
    " o=vec4(mix(v_c.rgb*a,v_ink*al,u_light),al*u_light);",
    "}",
  ].join("\n");

  /* sprites: the dot halo, the delegation bead and the session target, from gl_VertexID */
  var SPR_VS = [
    "#version 300 es",
    "precision highp float;",
    COMMON,
    "uniform vec2 u_dest; uniform float u_bead,u_show,u_halo,u_arrive,u_haloN;",
    "out vec4 v_c; out vec3 v_ink;",
    "const int HALO=" + HALO + ",STREAM=" + STREAM + ",TGT=" + TGT + ";",
    "vec4 h4(float n){ return fract(sin(vec4(n*12.9898,n*78.233,n*37.719,n*93.989))*43758.5453); }",
    "void main(){",
    " int id=gl_VertexID; vec2 px=u_c; float a=0.0, size=1.0; vec3 cd=vec3(1.0), cl=vec3(0.3,0.2,0.7);",
    " if(id<HALO){",
    "  vec4 h=h4(float(id)+1.0); vec4 h2=h4(float(id)+7919.0);",
    "  float rad=0.97+0.55*pow(h.y,2.6);",                       // densest just outside the rim, thinning outward
    "  float ring=0.0; for(int i=0;i<4;i++){ float ra=u_rings[i]; if(ra<1.0) ring+=u_ringAmp[i]*(1.0-ra)*exp(-pow((ra*1.4-0.2-(rad-0.97)*2.0)/0.3,2.0)); }",
    "  rad+= -0.06*u_listen*(0.4+u_amp)*(0.5+h.y) + 0.06*u_speak*(0.2+u_amp)*(0.4+h.y) + 0.07*ring;",
    "  float th=h.x*6.28318+u_t*0.02*(1.4-h.y)+u_rot*0.12;",
    "  vec2 d2=vec2(cos(th),sin(th));",
    "  px=u_c+d2*rad*u_R*0.92*(1.0+0.035*sin(th*5.0+u_flow*3.0)+0.02*sin(th*9.0-u_flow*2.0));",
    "  float k=gk(d2);",
    "  float tw=0.6+0.4*sin(u_t*(0.5+h.z*1.5)+h.w*6.28);",
    "  float fall=1.0-smoothstep(0.0,1.0,(rad-0.97)/0.55);",
    "  a=step(float(id),u_haloN)*u_halo*fall*(0.3+0.7*h.z)*tw*(0.55+0.9*pow(k,1.5)+0.5*pow(1.0-k,2.0))*1.6;",
    "  size=u_psz*(0.75+1.0*h2.x*h2.x);",
    "  cd=surfCol(k,1.0,false); cl=surfCol(k,1.0,true);",
    " } else if(id<HALO+STREAM){",
    // a stream of dots peels off the side facing the session and flows to it, accelerating then easing in
    "  int j=id-HALO; vec4 h=h4(float(j)+333.0);",
    "  float s=fract(u_bead*(0.85+0.3*h.x)+h.y);",
    "  float e=s*s*(3.0-2.0*s);",
    "  vec3 sp=normalize(u_T+vec3(h.z-0.5,h.w-0.5,(h.x-0.5)*0.5)*0.75);",
    "  vec2 P0=proj(sp*(1.0+0.02)); vec2 P2=u_dest+(h.zw-0.5)*max(u_R*0.08,4.0*u_psz);",
    "  vec2 dv=P2-P0; vec2 pr=vec2(-dv.y,dv.x);",
    "  vec2 P1=(P0+P2)*0.5+pr*(0.16+0.10*(h.w-0.5));",
    "  float q=1.0-e; px=q*q*P0+2.0*q*e*P1+e*e*P2;",
    "  a=u_deleg*u_deleg*pow(sin(3.14159*s),0.5)*(0.5+0.5*h.z)*2.4;",
    "  size=u_psz*(0.9+1.2*h.w);",
    "  float k=mix(gk(sp.xy),0.8,e); cd=mix(surfCol(k,0.8,false),vec3(1.0),0.25); cl=surfCol(k,0.8,true);",
    " } else {",
    "  int j=id-HALO-STREAM; float fi=float(j);",
    "  float y=1.0-(fi+0.5)/float(TGT)*2.0; float rd=sqrt(1.0-y*y); float th=fi*2.39996+u_t*0.4;",
    "  vec3 v=vec3(cos(th)*rd,y,sin(th)*rd);",
    "  float rt=max(u_R*0.09,5.0*u_psz);",
    "  px=u_dest+v.xy*rt*(1.0+0.08*u_arrive);",
    "  a=u_show*u_deleg*(0.22+0.40*(v.z*0.5+0.5))*(1.0+2.0*u_arrive);",
    "  size=u_psz*0.8; float k=0.8; cd=surfCol(k,0.5,false); cl=surfCol(k,0.5,true);",
    " }",
    " v_c=vec4(cd,clamp(a,0.0,1.0)); v_ink=cl;",
    " gl_Position=clip(px); gl_PointSize=max(size,1.0);",
    "}",
  ].join("\n");

  /*
   * The session spheres round JOYA AI (cc-family.js, with core D): small mesh replicas -- a coarse dotted
   * grid (9 rings x 18 meridians, two dots a cell edge) with the folds, rim glow, the session's own tint
   * woven into the gradient, and a light dot halo -- all of them in ONE draw on this canvas, positioned
   * from gl_VertexID and a few uniforms per sphere (opts.kids(), up to MAXK).
   */
  var MAXK = 12, KPER = 784;
  var KID_VS = [
    "#version 300 es",
    "precision highp float;",
    COMMON,
    "uniform vec4 u_kA[" + MAXK + "], u_kB[" + MAXK + "], u_kC[" + MAXK + "];",
    "uniform vec3 u_kTD[" + MAXK + "], u_kTL[" + MAXK + "];",
    "uniform float u_kN, u_dpr;",
    "out vec4 v_c; out vec3 v_ink;",
    "vec4 h4(float n){ return fract(sin(vec4(n*12.9898,n*78.233,n*37.719,n*93.989))*43758.5453); }",
    "void main(){",
    " int id=gl_VertexID; int ki=id/" + KPER + "; int li=id-ki*" + KPER + ";",
    " gl_PointSize=1.0; gl_Position=vec4(2.0,2.0,0.0,1.0); v_c=vec4(0.0); v_ink=vec3(0.0);",
    " if(float(ki)>=u_kN) return;",
    " vec4 A=u_kA[ki], B=u_kB[ki], Q=u_kC[ki];",                  // A: x, y, r (device px, y up), alpha · B: rot, fold phase, amber, shimmer · Q: form, dissolve, catch, seed
    " vec4 h=h4(float(li)+Q.w*97.0);",
    " vec2 uv=vec2(0.0); bool halo=false; bool cross=false;",
    " if(li<324){ int i=li/36+1; int j=li-(li/36)*36; uv=vec2(float(i)/10.0,float(j)/36.0); cross=(j-(j/2)*2)==0; }",
    " else if(li<684){ int m=li-324; int j=m/20; int i=m-j*20; uv=vec2(float(i)/20.0,float(j)/18.0); cross=(i-(i/2)*2)==0; }",
    " else halo=true;",
    " vec2 px; float a; float k; float fres=1.0; float front=1.0;",
    " if(!halo){",
    "  vec3 w=dirOf(uv); vec3 v=rotX(rotY(w,B.x),0.30);",
    "  float d=(0.085+0.045*B.w)*snoise(w*1.9+vec3(0.0,B.y,B.y*0.6));",
    "  vec3 p=v*(1.0+d); float s=3.6/(3.6-p.z);",
    "  px=A.xy+p.xy*s*A.z*0.92;",
    "  front=smoothstep(-0.35,0.45,p.z); fres=1.0-abs(v.z); k=gk(p.xy);",
    "  float rim=fres*fres; float warm=smoothstep(0.45,1.0,k); float cool=1.0-smoothstep(0.0,0.45,k);",
    "  a=(0.16+0.72*front)*(1.0+2.2*rim*warm+1.5*rim*cool+0.9*B.w*rim)*(cross?1.25:0.85)*smoothstep(0.02,0.30,sin(uv.x*PI));",
    "  gl_PointSize=u_psz*(cross?1.3:1.0)*(0.85+0.4*front);",
    " } else {",
    "  float th=h.x*6.28318+u_t*0.03; float rr=1.08+0.42*pow(h.y,2.0); vec2 d2=vec2(cos(th),sin(th));",
    "  px=A.xy+d2*rr*A.z*0.92; k=gk(d2);",
    "  a=(1.0-smoothstep(0.0,1.0,(rr-1.08)/0.42))*(0.3+0.7*h.z)*0.7;",
    "  gl_PointSize=u_psz*(0.6+0.6*h.w);",
    " }",
    // born: the dots stream out of JOYA AI and condense; gone: they drift back into her
    " vec2 home=u_c+(h.zw-0.5)*u_R*0.9;",
    " if(Q.x<1.0){ float pp=clamp((Q.x-h.x*0.45)/0.55,0.0,1.0); pp=pp*pp*(3.0-2.0*pp); vec2 m=(home+px)*0.5+vec2(h.y-0.5,h.x-0.5)*vec2(160.0,120.0)*u_dpr; float u=1.0-pp; px=u*u*home+2.0*u*pp*m+pp*pp*px; a=max(a,0.45)*(0.7+0.3*pp); }",
    " if(Q.y>0.0){ float q=clamp((Q.y-h.x*0.4)/0.6,0.0,1.0); q=q*q*(3.0-2.0*q); vec2 m=(home+px)*0.5+vec2(h.y-0.5,h.z-0.5)*220.0*u_dpr*sin(q*PI); float u=1.0-q; px=u*u*px+2.0*u*q*m+q*q*home; a*=1.0-q*0.9; }",
    " a*=A.w*(1.0+0.9*Q.z)*2.3;",
    " vec3 cd=mix(gradD(k),u_kTD[ki],0.45), cl=mix(gradL(k),u_kTL[ki],0.45);",
    " float nt=B.z*smoothstep(0.3,0.95,fres);",
    " cd=mix(cd,vec3(1.0,0.62,0.28),nt); cl=mix(cl,vec3(0.80,0.40,0.05),nt);",
    " if(cross&&!halo) cd=mix(cd,vec3(1.0),0.25*front);",
    " v_c=vec4(cd,clamp(a,0.0,1.0)); v_ink=cl;",
    " gl_Position=clip(px);",
    "}",
  ].join("\n");
  var SPR_FS = [
    "#version 300 es",
    "precision highp float;",
    "in vec4 v_c; in vec3 v_ink; uniform float u_light; out vec4 o;",
    "void main(){ vec2 q=gl_PointCoord*2.0-1.0; float r2=dot(q,q); if(r2>1.0) discard;",
    " float a=v_c.a*exp(-r2*2.2); float al=min(1.0,a*1.2);",
    " o=vec4(mix(v_c.rgb*a,v_ink*al,u_light),al*u_light); }",
  ].join("\n");

  /* grid: (lat+1) x (lon+1) vertices; indices for fill triangles and for lines */
  function grid(lat, lon, sub) {
    var uv = new Float32Array((lat + 1) * (lon + 1) * 2), n = 0;
    for (var i = 0; i <= lat; i++) for (var j = 0; j <= lon; j++) { uv[n++] = i / lat; uv[n++] = j / lon; }
    var V = function (i, j) { return i * (lon + 1) + j; };
    var tri = [], lines = [];
    for (i = 0; i < lat; i++) for (j = 0; j < lon; j++) {
      tri.push(V(i, j), V(i + 1, j), V(i, j + 1), V(i, j + 1), V(i + 1, j), V(i + 1, j + 1));
      if (i > 0) lines.push(V(i, j), V(i, j + 1));         // latitude rings (no ring at the poles)
      lines.push(V(i, j), V(i + 1, j));                     // meridians
    }
    // crossings: every vertex except the poles
    var pts = [];
    for (i = 1; i < lat; i++) for (j = 0; j < lon; j++) pts.push(V(i, j));
    // the grid's lines as rows of dots: sub dots per cell edge along every ring and meridian
    var dots = [];
    for (i = 1; i < lat; i++) for (j = 0; j < lon * sub; j++) dots.push(i / lat, j / (lon * sub));
    for (j = 0; j < lon; j++) for (i = 0; i < lat * sub; i++) { if (i % sub === 0) continue; dots.push(i / (lat * sub), j / lon); }
    return { uv: uv, tri: new Uint16Array(tri), lines: new Uint16Array(lines), pts: new Uint16Array(pts), dots: new Float32Array(dots) };
  }
  function detailFor(Rdev) {
    if (Rdev >= 200) return [72, 128, 3];
    if (Rdev >= 130) return [52, 92, 3];
    if (Rdev >= 70) return [30, 52, 2];
    if (Rdev >= 36) return [24, 40, 2];
    return [16, 28, 1];
  }

  window.JoyaCoreD = function (canvas, opts) {
    opts = opts || {};
    var GLOW = opts.backdrop !== "full";
    var reduceMq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    var S = {
      concept: "D", state: "idle", amp: 0, ampSlow: 0, t: 0, c: [0, 0], R: 200, light: 0, lightT: 0, dpr: 1, cssW: 0, cssH: 0,
      arrive: 0, flow: 0, rot: 0, ripple: 0, grad: -0.785, twPh: 0, bead: 0,
      rings: [9, 9, 9, 9], ringAmp: [0, 0, 0, 0], lastRing: -9,
      running: false, wanted: false, still: !!(reduceMq && reduceMq.matches), frames: [], gl: false, lowRes: false,
    };
    var W = {};
    KEYS.forEach(function (k) { W[k] = 0; });
    var kidP = null, kidBuf = null, dotVao = null, gl = null, bgP = null, meshP = null, sprP = null, quadVao = null, meshVao = null, sprVao = null;
    var buf = {}, G = null, detail = null, raf = 0, last = 0, ctx = null;
    var ampFn = opts.amp || null, destFn = opts.dest || null, onFrame = opts.onFrame || null, lastSize = null;

    function sh(type, src) {
      var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "compile");
      return s;
    }
    function prog(vs, fs, attr) {
      var p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      if (attr) gl.bindAttribLocation(p, 0, attr);
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "link");
      var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (var i = 0; i < n; i++) { var a = gl.getActiveUniform(p, i); u[a.name.replace(/\[0\]$/, "")] = gl.getUniformLocation(p, a.name); }
      return { p: p, u: u };
    }
    function initGL() {
      if (opts.force2d) return false;
      try {
        gl = canvas.getContext("webgl2", { alpha: GLOW, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: !!opts.preserve });
        if (!gl) return false;
        bgP = prog(BG_VS, BG_FS, "a_p"); meshP = prog(MESH_VS, MESH_FS, "a_uv"); sprP = prog(SPR_VS, SPR_FS); kidP = prog(KID_VS, SPR_FS);
        quadVao = gl.createVertexArray(); gl.bindVertexArray(quadVao);
        var q = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, q);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        sprVao = gl.createVertexArray();
        meshVao = gl.createVertexArray();
        buf.uv = gl.createBuffer(); buf.dots = gl.createBuffer(); dotVao = gl.createVertexArray(); buf.tri = gl.createBuffer(); buf.lines = gl.createBuffer(); buf.pts = gl.createBuffer();
        gl.bindVertexArray(null);
        return true;
      } catch (e) {
        if (window.console) console.warn("[core D] WebGL2 unavailable, drawing in 2D:", e && e.message);
        gl = null;
        if (canvas.parentNode) { var fresh = canvas.cloneNode(false); canvas.parentNode.replaceChild(fresh, canvas); canvas = fresh; }
        return false;
      }
    }
    function ensureMesh() {
      var d = detailFor(S.R);
      if (detail && d[0] === detail[0] && d[1] === detail[1]) return;
      detail = d; G = grid(d[0], d[1], d[2]);
      gl.bindVertexArray(meshVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf.uv); gl.bufferData(gl.ARRAY_BUFFER, G.uv, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(dotVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf.dots); gl.bufferData(gl.ARRAY_BUFFER, G.dots, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf.tri); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, G.tri, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf.lines); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, G.lines, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf.pts); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, G.pts, gl.STATIC_DRAW);
    }

    function beat(t) {
      var b = (t / 1.8) % 1;
      return Math.exp(-Math.pow((b - 0.05) / 0.05, 2)) + 0.7 * Math.exp(-Math.pow((b - 0.25) / 0.055, 2));
    }
    function destGL() {
      var dpr = S.dpr, d = destFn ? destFn() : null;
      if (!d) {
        var m = Math.max(8, S.R / dpr * 0.14);
        d = [Math.min(S.cssW - m, S.c[0] / dpr + S.R / dpr * 1.6), Math.max(m, S.cssH - S.c[1] / dpr - S.R / dpr * 0.9)];
      }
      return [d[0] * dpr, (S.cssH - d[1]) * dpr];
    }
    function common(u, bt, dst) {
      gl.uniform2f(u.u_res, canvas.width, canvas.height); gl.uniform2f(u.u_c, S.c[0], S.c[1]); gl.uniform1f(u.u_R, S.R);
      gl.uniform1f(u.u_t, S.t); gl.uniform1f(u.u_flow, S.flow); gl.uniform1f(u.u_rot, S.rot); gl.uniform1f(u.u_amp, S.amp);
      gl.uniform1f(u.u_light, S.light); gl.uniform1f(u.u_beat, bt); gl.uniform1f(u.u_grad, S.grad); gl.uniform1f(u.u_ripple, S.ripple);
      gl.uniform1f(u.u_tw, Math.sin(S.twPh)); gl.uniform1f(u.u_psz, S.dpr * Math.max(0.7, Math.min(1.2, S.R / S.dpr / 240)) * 1.6);
      gl.uniform1f(u.u_listen, W.listen); gl.uniform1f(u.u_think, W.think); gl.uniform1f(u.u_speak, W.speak);
      gl.uniform1f(u.u_deleg, W.deleg); gl.uniform1f(u.u_need, W.need);
      var dx = dst[0] - S.c[0], dy = dst[1] - S.c[1], L = Math.hypot(dx, dy) || 1, T = [dx / L, dy / L, 0.45], TL = Math.hypot(T[0], T[1], T[2]);
      gl.uniform3f(u.u_T, T[0] / TL, T[1] / TL, T[2] / TL);
      gl.uniform4f(u.u_rings, S.rings[0], S.rings[1], S.rings[2], S.rings[3]);
      gl.uniform4f(u.u_ringAmp, S.ringAmp[0], S.ringAmp[1], S.ringAmp[2], S.ringAmp[3]);
    }
    /* the session spheres (opts.kids(): [{x, y, r, alpha, rot, phase, amb, shimmer, form, dis, catch, seed, tint:[r,g,b], tintL:[r,g,b]}], CSS px) */
    function drawKids(bt, dst) {
      var list = opts.kids ? opts.kids() : null;
      if (!list || !list.length) return;
      var n = Math.min(MAXK, list.length), dpr = S.dpr;
      if (!kidBuf) kidBuf = { A: new Float32Array(MAXK * 4), B: new Float32Array(MAXK * 4), C: new Float32Array(MAXK * 4), TD: new Float32Array(MAXK * 3), TL: new Float32Array(MAXK * 3) };
      for (var i = 0; i < n; i++) {
        var k = list[i], o4 = i * 4, o3 = i * 3;
        kidBuf.A[o4] = k.x * dpr; kidBuf.A[o4 + 1] = (S.cssH - k.y) * dpr; kidBuf.A[o4 + 2] = k.r * dpr; kidBuf.A[o4 + 3] = k.alpha;
        kidBuf.B[o4] = k.rot; kidBuf.B[o4 + 1] = k.phase; kidBuf.B[o4 + 2] = k.amb; kidBuf.B[o4 + 3] = k.shimmer;
        kidBuf.C[o4] = k.form; kidBuf.C[o4 + 1] = k.dis; kidBuf.C[o4 + 2] = k.catchK; kidBuf.C[o4 + 3] = k.seed;
        kidBuf.TD[o3] = k.tint[0] / 255; kidBuf.TD[o3 + 1] = k.tint[1] / 255; kidBuf.TD[o3 + 2] = k.tint[2] / 255;
        kidBuf.TL[o3] = k.tintL[0] / 255; kidBuf.TL[o3 + 1] = k.tintL[1] / 255; kidBuf.TL[o3 + 2] = k.tintL[2] / 255;
      }
      gl.useProgram(kidP.p); var u = kidP.u; common(u, bt, dst);
      gl.uniform4fv(u.u_kA, kidBuf.A); gl.uniform4fv(u.u_kB, kidBuf.B); gl.uniform4fv(u.u_kC, kidBuf.C);
      gl.uniform3fv(u.u_kTD, kidBuf.TD); gl.uniform3fv(u.u_kTL, kidBuf.TL);
      gl.uniform1f(u.u_kN, n); gl.uniform1f(u.u_dpr, dpr);
      gl.uniform1f(u.u_psz, dpr * 1.35);
      gl.bindVertexArray(sprVao);
      gl.drawArrays(gl.POINTS, 0, n * KPER);
    }
    function drawGL() {
      var cw = canvas.width, ch = canvas.height, u, bt = beat(S.t), dst = destGL();
      ensureMesh();
      gl.viewport(0, 0, cw, ch);
      // background
      gl.disable(gl.BLEND);
      gl.useProgram(bgP.p); u = bgP.u; gl.bindVertexArray(quadVao);
      gl.uniform2f(u.u_res, cw, ch); gl.uniform2f(u.u_c, S.c[0], S.c[1]); gl.uniform1f(u.u_R, S.R); gl.uniform1f(u.u_light, S.light);
      gl.uniform1f(u.u_grad, S.grad); gl.uniform1f(u.u_need, W.need); gl.uniform1f(u.u_beat, bt); gl.uniform1f(u.u_speak, W.speak); gl.uniform1f(u.u_amp, S.amp); gl.uniform1f(u.u_glow, GLOW ? 1 : 0);
      if (GLOW) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
      if (opts.backdrop !== "none") gl.drawArrays(gl.TRIANGLES, 0, 6); // "none": no glow at all (the dock: a 68 px canvas would show its square)
      // mesh
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(meshP.p); u = meshP.u; common(u, bt, dst);
      var dens = (S.R / S.dpr < 100 ? 1.5 : 1.0) * (S.dpr > 1.4 ? 1.3 : 1);
      gl.uniform1f(u.u_dens, dens);
      gl.bindVertexArray(meshVao);
      gl.uniform1f(u.u_mode, 0); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf.tri); gl.drawElements(gl.TRIANGLES, G.tri.length, gl.UNSIGNED_SHORT, 0);
      gl.uniform1f(u.u_mode, 2); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf.pts); gl.drawElements(gl.POINTS, G.pts.length, gl.UNSIGNED_SHORT, 0);
      gl.bindVertexArray(dotVao);
      gl.uniform1f(u.u_mode, 1); gl.drawArrays(gl.POINTS, 0, G.dots.length / 2);
      // sprites
      gl.useProgram(sprP.p); u = sprP.u; common(u, bt, dst);
      gl.uniform2f(u.u_dest, dst[0], dst[1]); gl.uniform1f(u.u_bead, S.bead); gl.uniform1f(u.u_show, opts.showTarget ? 1 : 0);
      gl.uniform1f(u.u_halo, opts.halo === false ? 0 : 1); gl.uniform1f(u.u_haloN, Math.max(500, Math.min(HALO, S.R / S.dpr * 18))); gl.uniform1f(u.u_arrive, S.arrive);
      gl.bindVertexArray(sprVao);
      gl.drawArrays(gl.POINTS, 0, NSPR);
      drawKids(bt, dst);
      gl.bindVertexArray(null);
    }

    /* ------------------------------------------------------- Canvas 2D fallback */
    function draw2d() {
      var cw = canvas.width, ch = canvas.height, cx = S.c[0], cy = ch - S.c[1], R = S.R * 0.92, L = S.light > 0.5;
      var g = ctx.createRadialGradient(cx, cy, R * 0.3, cx, cy, Math.max(cw, ch) * 0.8);
      if (L) { g.addColorStop(0, "#ece8fb"); g.addColorStop(1, "#f8f8fc"); } else { g.addColorStop(0, "#22103a"); g.addColorStop(0.4, "#0b1030"); g.addColorStop(1, "#05060f"); }
      ctx.globalCompositeOperation = "source-over";
      if (GLOW) ctx.clearRect(0, 0, cw, ch); else { ctx.fillStyle = g; ctx.fillRect(0, 0, cw, ch); }
      ctx.globalCompositeOperation = L ? "source-over" : "lighter"; ctx.lineWidth = S.dpr * 0.8;
      var lat = 14, lon = 22, rot = S.rot;
      function P(th, ph) {
        var x = Math.sin(th) * Math.cos(ph), y = Math.cos(th), z = Math.sin(th) * Math.sin(ph);
        var c = Math.cos(rot), s = Math.sin(rot), X = c * x + s * z, Z = -s * x + c * z;
        var d = 1 + (0.06 + 0.06 * W.think) * Math.sin(x * 3 + S.flow * 3) * Math.cos(y * 4 - S.flow * 2) * Math.sin(z * 3 + 1);
        return [cx + X * R * d, cy - y * R * d, Z];
      }
      function col(px, py, a) {
        var k = Math.max(0, Math.min(1, ((px - cx) - (py - cy)) / (2 * R) * 0.9 + 0.5));
        var r = L ? 20 + 180 * k : 30 + 225 * k, gg = L ? 110 - 90 * k : 200 - 140 * k, b = L ? 200 : 255;
        return "rgba(" + (r | 0) + "," + (gg | 0) + "," + b + "," + a.toFixed(3) + ")";
      }
      for (var i = 1; i < lat; i++) for (var j = 0; j < lon; j++) {
        var a = P(i / lat * Math.PI, j / lon * 2 * Math.PI), b = P(i / lat * Math.PI, (j + 1) / lon * 2 * Math.PI), c = P((i + 1) / lat * Math.PI, j / lon * 2 * Math.PI);
        var al = a[2] > 0 ? 0.45 : 0.12;
        ctx.strokeStyle = col(a[0], a[1], al);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.moveTo(a[0], a[1]); ctx.lineTo(c[0], c[1]); ctx.stroke();
      }
      ctx.globalCompositeOperation = "source-over";
    }

    /* ------------------------------------------------------- simulation */
    function step(dt) {
      S.t += dt;
      var tg = TARGETS[S.state] || {}, k = 1 - Math.exp(-dt * 3.2);
      KEYS.forEach(function (key) { W[key] += ((tg[key] || 0) - W[key]) * k; });
      S.light += (S.lightT - S.light) * (1 - Math.exp(-dt * 4));
      var talking = S.state === "listening" || S.state === "speaking";
      var real = talking && ampFn ? ampFn(S.state) : null;
      var target = !talking ? 0 : real == null || real < 0 ? (S.state === "listening" ? synthListen(S.t) : synthAmp(S.t)) : Math.max(0, Math.min(1, real));
      S.amp += (target - S.amp) * (1 - Math.exp(-dt * (target > S.amp ? 24 : 8)));
      S.ampSlow += (S.amp - S.ampSlow) * (1 - Math.exp(-dt * 3));
      var a = S.amp;
      S.flow += dt * (0.045 + 0.03 * W.think + 0.02 * W.speak);
      S.rot += dt * (0.10 + 0.04 * W.think);
      S.ripple -= dt * W.listen * (2.0 + 3.0 * a);                 // ripples travel in toward the front
      S.grad += dt * 0.35 * W.think;                                // the gradient turns round while thinking
      if (W.think < 0.02) S.grad += ((-0.785 + Math.round((S.grad + 0.785) / 6.28318) * 6.28318) - S.grad) * (1 - Math.exp(-dt * 0.6));
      S.twPh += dt * 0.5 * W.think;
      S.bead += dt * 0.38;
      S.arrive += ((S.state === "delegating" ? 1 : 0) - S.arrive) * (1 - Math.exp(-dt * (S.state === "delegating" ? 0.9 : 3)));
      for (var i = 0; i < 4; i++) S.rings[i] += dt / 1.6;
      if (W.speak > 0.35 && a - S.ampSlow > 0.12 && S.t - S.lastRing > 0.38) spawnRing(Math.min(1, 0.35 + 0.65 * a));
    }
    function spawnRing(amp) {
      var o = 0;
      for (var i = 1; i < 4; i++) if (S.rings[i] > S.rings[o]) o = i;
      S.rings[o] = 0; S.ringAmp[o] = amp; S.lastRing = S.t;
    }
    function draw() {
      if (!canvas.width || !canvas.height) return;
      if (gl) drawGL(); else if (ctx) draw2d();
      if (onFrame) onFrame(S, W);
    }
    var slowSince = 0;
    function guard(now) {
      if (S.lowRes || opts.noGuard || S.frames.length < 30) return;
      var f = S.frames, iv = (f[f.length - 1][0] - f[f.length - 30][0]) / 29;
      if (iv > 22) { if (!slowSince) slowSince = now; else if (now - slowSince > 2000) { S.lowRes = true; if (lastSize) resize.apply(null, lastSize); if (window.console) console.info("[core D] drawing at 0.7x resolution (" + iv.toFixed(1) + " ms a frame)"); } }
      else slowSince = 0;
    }
    function frame(now) {
      raf = 0;
      if (!S.running) return;
      var dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
      last = now;
      var t0 = performance.now();
      step(dt);
      if (opts.beforeDraw) opts.beforeDraw(S, W); // the family of spheres moves first, so its meshes are drawn where its names are
      draw();
      S.frames.push([now, performance.now() - t0]);
      if (S.frames.length > 360) S.frames.shift();
      guard(now);
      raf = requestAnimationFrame(frame);
    }
    function start() {
      S.wanted = true;
      if (S.still) { stillFrame(); return; }
      if (S.running || document.hidden) return;
      S.running = true; last = 0; raf = requestAnimationFrame(frame);
    }
    function stop(keep) { S.running = false; if (!keep) S.wanted = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
    function stillFrame() {
      var tg = TARGETS[S.state] || {};
      KEYS.forEach(function (k) { W[k] = tg[k] || 0; });
      S.light = S.lightT;
      S.amp = S.state === "listening" || S.state === "speaking" ? 0.55 : 0;
      if (S.state === "speaking") { S.rings = [0.2, 0.55, 9, 9]; S.ringAmp = [0.8, 0.5, 0, 0]; }
      S.bead = 0.4; S.flow = 1.3; S.twPh = 1.2;
      draw();
    }
    function onVis() { if (document.hidden) stop(true); else if (S.wanted) start(); }
    document.addEventListener("visibilitychange", onVis);
    if (reduceMq && reduceMq.addEventListener) reduceMq.addEventListener("change", function () {
      S.still = reduceMq.matches; if (S.still) { stop(true); stillFrame(); } else if (S.wanted) start();
    });
    function resize(cx, cy, R, w, h) {
      lastSize = [cx, cy, R, w, h];
      var dpr = Math.min(window.devicePixelRatio || 1, 2) * (S.lowRes ? 0.7 : 1);
      w = w || canvas.clientWidth || window.innerWidth; h = h || canvas.clientHeight || window.innerHeight;
      var pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
      S.cssW = w; S.cssH = h; S.dpr = dpr;
      S.c = [cx * dpr, (h - cy) * dpr]; S.R = R * dpr;
      if (S.still || !S.running) draw();
    }
    function stats() {
      var f = S.frames; if (f.length < 10) return null;
      var cost = f.map(function (x) { return x[1]; }).sort(function (a, b) { return a - b; }), iv = [];
      for (var i = 1; i < f.length; i++) iv.push(f[i][0] - f[i - 1][0]);
      iv.sort(function (a, b) { return a - b; });
      var med = function (a) { return a[Math.floor(a.length / 2)]; }, p95 = function (a) { return a[Math.floor(a.length * 0.95)]; };
      return { cpuMed: med(cost), cpuP95: p95(cost), interval: med(iv), intervalP95: p95(iv), fps: 1000 / med(iv), n: f.length, gl: !!gl };
    }

    if (initGL()) S.gl = true; else ctx = canvas.getContext("2d");

    return {
      S: S, W: W, STATES: STATES,
      get isGL() { return !!gl; },
      get canvas() { return canvas; },
      setState: function (s) { if (STATES.indexOf(s) < 0) s = "idle"; if (s === S.state) return; S.state = s; if (S.still) stillFrame(); },
      setLight: function (on, instant) { S.lightT = on ? 1 : 0; if (instant) S.light = S.lightT; if (S.still || !S.running) { S.light = S.lightT; draw(); } },
      resize: resize, start: start, stop: function () { stop(false); }, still: stillFrame, stats: stats, draw: draw,
      resetStats: function () { S.frames = []; },
      setGuard: function (on) { opts.noGuard = !on; },
      /**
       * Driven from outside (joya-shell.js's flight between the Command Center and the dock): move
       * without drawing (place), then advance and draw one frame (tick) -- no loop of its own.
       */
      place: function (cx, cy, R) {
        lastSize = [cx, cy, R, S.cssW, S.cssH];
        S.c = [cx * S.dpr, (S.cssH - cy) * S.dpr]; S.R = R * S.dpr;
      },
      tick: function (dt) {
        if (!gl && !ctx) return;
        step(Math.max(0, Math.min(0.05, dt || 0.016)));
        if (opts.beforeDraw) opts.beforeDraw(S, W);
        draw();
      },
      /** Carry on exactly where another core D left off: state, weights, voice level and every phase. */
      adopt: function (o) {
        if (!o || !o.S || o.S.concept !== "D") return;
        var a = o.S;
        ["t", "flow", "rot", "ripple", "grad", "twPh", "bead", "amp", "ampSlow", "arrive", "lastRing", "light", "lightT"].forEach(function (k) { if (typeof a[k] === "number") S[k] = a[k]; });
        S.rings = a.rings.slice(); S.ringAmp = a.ringAmp.slice(); S.state = a.state;
        KEYS.forEach(function (k) { if (typeof o.W[k] === "number") W[k] = o.W[k]; });
      },
      /** Only one core lives here; the other concepts are joya-core.js (cc-map.js swaps the canvas). */
      setConcept: function () {},
      /** Stop and give the GPU context back (cc-map.js calls it before swapping to A/B/C). */
      destroy: function () {
        stop(false);
        document.removeEventListener("visibilitychange", onVis);
        try { var lc = gl && gl.getExtension("WEBGL_lose_context"); if (lc) lc.loseContext(); } catch (e) { /* gone already */ }
        gl = null; ctx = null;
      },
    };
  };
})();
