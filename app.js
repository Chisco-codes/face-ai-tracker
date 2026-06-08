// ═══════════════════════════════════════════════════════════════
// FACE AI TRACKER — app.js  (Fixed + Redesigned)
// Fixes: blink detection (thr undefined), Android hang,
//        iOS install button, landmark count, feedback modal
// ═══════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────
// 1. CONFIG
// ─────────────────────────────────────────────────────────────
var CONFIG = {
  DOT_RADIUS:        1.4,
  DOT_COLOR:         'rgba(0,229,255,0.55)',
  EYE_DOT_COLOR:     '#ff3366',
  EYE_DOT_RADIUS:    3,
  BOX_COLOR:         'rgba(0,229,255,0.4)',
  FPS_INTERVAL:      500,

  // Blink detection
  BLINK_DROP:        0.055,
  EAR_FLOOR:         0.10,
  EAR_FALLBACK:      0.13,
  BLINK_FRAMES:      3,         // slightly faster response

  // Calibration
  CALIB_DURATION_MS: 4000,

  // Head pose thresholds (degrees)
  TILT_THRESHOLD:    15,
  NOD_THRESHOLD:     12,

  // Focus score weights
  W_EAR:             0.35,
  W_BLINK:           0.25,
  W_HEAD:            0.25,
  W_EMOTION:         0.15,

  NORMAL_BPM:        16,
  SMOOTH:            0.92,

  // Emotion detection
  EMOTION_EVERY_N_FRAMES: 3,
  EMOTION_SMOOTH:         0.80,
  EMOTION_MIN_CONFIDENCE: 0.05,
  EMOTION_VOTE_WINDOW:    12,
  EMOTION_VOTE_THRESHOLD: 0.60,
};


// ─────────────────────────────────────────────────────────────
// 2. LANDMARK INDICES
// ─────────────────────────────────────────────────────────────
var LM = {
  RIGHT_EYE:    [33,  160, 158, 133, 153, 144],
  LEFT_EYE:     [263, 387, 385, 362, 380, 373],
  NOSE_TIP:     1,
  NOSE_BRIDGE:  168,
  LEFT_TEMPLE:  234,
  RIGHT_TEMPLE: 454,
  CHIN:         152,
  FOREHEAD:     10,
};

var EMOTION_CONFIG = {
  happy:     { emoji: '😊', label: 'Happy'     },
  neutral:   { emoji: '😐', label: 'Neutral'   },
  sad:       { emoji: '😔', label: 'Sad'       },
  angry:     { emoji: '😠', label: 'Angry'     },
  surprised: { emoji: '😲', label: 'Surprised' },
  fearful:   { emoji: '😨', label: 'Fearful'   },
  disgusted: { emoji: '🤢', label: 'Disgusted' },
};


// ─────────────────────────────────────────────────────────────
// 3. STATE
// ─────────────────────────────────────────────────────────────
var STATE = {
  meshModel:          null,
  emotionModelReady:  false,
  isRunning:          false,
  animFrameId:        null,
  lastFrameTime:      0,
  frameCount:         0,

  calibrating:        false,
  calibDone:          false,
  calibSamples:       [],
  calibStartTime:     0,
  earBaseline:        0.19,
  earThreshold:       CONFIG.EAR_FALLBACK,   // ← always set here

  blinkState:         'OPEN',
  blinkFrameCount:    0,
  blinkTotal:         0,
  sessionStart:       0,

  framesSinceEmotion: 0,
  smoothedEmotions: {
    happy:0, neutral:0.5, sad:0, angry:0, surprised:0, fearful:0, disgusted:0,
  },
  currentEmotion:     'neutral',
  emotionConfidence:  0,
  emotionVoteHistory: [],
  confirmedEmotion:   'neutral',

  smoothFocus:      50,
  lastEAR:          0.19,
  headTiltAngle:    0,
  headNodAngle:     0,
  scaleX:           1,
  scaleY:           1,
  lastDetectionTime:0,
};


// ─────────────────────────────────────────────────────────────
// 4. DOM REFERENCES
// ─────────────────────────────────────────────────────────────
var DOM = {
  video:           document.getElementById('webcam'),
  canvas:          document.getElementById('overlay-canvas'),
  startBtn:        document.getElementById('start-btn'),
  statusDot:       document.getElementById('status-dot'),
  statusText:      document.getElementById('status-text'),
  faceDetected:    document.getElementById('face-detected'),
  landmarkCount:   document.getElementById('landmark-count'),
  fpsValue:        document.getElementById('fps-value'),
  tfStatus:        document.getElementById('tf-status'),
  modelStatus:     document.getElementById('model-status'),
  emotionModelStatus: document.getElementById('emotion-model-status'),
  earValue:        document.getElementById('ear-value'),
  blinkCount:      document.getElementById('blink-count'),
  blinkRate:       document.getElementById('blink-rate'),
  headTilt:        document.getElementById('head-tilt'),
  headNod:         document.getElementById('head-nod'),
  focusScore:      document.getElementById('focus-score'),
  feedbackText:    document.getElementById('feedback-text'),
  calibStatus:     document.getElementById('calib-status'),
  emotionEmoji:    document.getElementById('emotion-emoji'),
  emotionName:     document.getElementById('emotion-name'),
  emotionConf:     document.getElementById('emotion-confidence'),
  emotionStatus:   document.getElementById('emotion-status'),
};

var CTX = DOM.canvas.getContext('2d');


// ─────────────────────────────────────────────────────────────
// 5. MATH HELPERS
// ─────────────────────────────────────────────────────────────
function dist(a, b) {
  var dx = b.x - a.x, dy = b.y - a.y;
  return Math.sqrt(dx*dx + dy*dy);
}
function calcEAR(pts) {
  var v1 = dist(pts[1], pts[5]);
  var v2 = dist(pts[2], pts[4]);
  var h  = dist(pts[0], pts[3]);
  if (h < 0.001) return 0;
  return (v1 + v2) / (2.0 * h);
}
function getKP(kpts, idx) {
  return (kpts && idx < kpts.length) ? kpts[idx] : null;
}
function getKPGroup(kpts, indices) {
  var out = [];
  for (var i = 0; i < indices.length; i++) {
    var p = getKP(kpts, indices[i]);
    if (!p) return null;
    out.push(p);
  }
  return out;
}
function angleDeg(p1, p2) {
  return Math.atan2(p2.y - p1.y, p2.x - p1.x) * (180 / Math.PI);
}
function lerp(cur, tgt, f)  { return cur * f + tgt * (1 - f); }
function clamp(v, lo, hi)   { return Math.min(Math.max(v, lo), hi); }
function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce(function(s,v){return s+v;},0) / arr.length;
}
function topPercent(arr, pct) {
  if (!arr.length) return arr;
  var sorted = arr.slice().sort(function(a,b){return a-b;});
  var cutoff = Math.floor(sorted.length * (1 - pct));
  return sorted.slice(cutoff);
}


// ─────────────────────────────────────────────────────────────
// 6. CALIBRATION
// ─────────────────────────────────────────────────────────────
function startCalibration() {
  STATE.calibrating    = true;
  STATE.calibDone      = false;
  STATE.calibSamples   = [];
  STATE.calibStartTime = performance.now();
  setStatus('👀 Calibrating — keep eyes OPEN, look at camera...', 'waiting');
  if (DOM.calibStatus) DOM.calibStatus.style.display = 'flex';
}

function runCalibration(ear) {
  var elapsed  = performance.now() - STATE.calibStartTime;
  var progress = Math.min(elapsed / CONFIG.CALIB_DURATION_MS, 1);

  if (DOM.calibStatus) {
    var bar   = DOM.calibStatus.querySelector('.calib-bar-fill');
    var label = DOM.calibStatus.querySelector('.calib-label');
    if (bar)   bar.style.width     = Math.round(progress * 100) + '%';
    if (label) label.textContent   = 'Calibrating... ' + Math.round(progress * 100) + '%';
  }

  if (ear > 0.10) STATE.calibSamples.push(ear);

  if (elapsed >= CONFIG.CALIB_DURATION_MS) {
    STATE.calibrating = false;
    STATE.calibDone   = true;

    if (STATE.calibSamples.length >= 3) {
      var topSamples    = topPercent(STATE.calibSamples, 0.60);
      STATE.earBaseline = avg(topSamples);
    } else if (STATE.calibSamples.length > 0) {
      STATE.earBaseline = avg(STATE.calibSamples);
    } else {
      STATE.earBaseline = STATE.lastEAR > 0.12 ? STATE.lastEAR : 0.19;
    }
    // ── FIX: always set earThreshold from earBaseline ─────
    STATE.earThreshold = Math.max(
      STATE.earBaseline - CONFIG.BLINK_DROP,
      CONFIG.EAR_FLOOR
    );

    console.log('[Calibration] Baseline:', STATE.earBaseline.toFixed(4),
                '| Threshold:', STATE.earThreshold.toFixed(4));

    if (DOM.calibStatus) DOM.calibStatus.style.display = 'none';
    setStatus('Detection running — look at the camera!', 'running');
  }
}


// ─────────────────────────────────────────────────────────────
// 7. EMOTION DETECTION
// ─────────────────────────────────────────────────────────────
async function detectEmotions() {
  if (!STATE.emotionModelReady) return null;
  if (DOM.video.readyState < 2 || DOM.video.videoWidth === 0) return null;
  try {
    var result = await faceapi
      .detectSingleFace(DOM.video,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.3 }))
      .withFaceExpressions();
    if (!result || !result.expressions) return null;
    return result.expressions;
  } catch (err) {
    return null;
  }
}

function smoothEmotions(newExpressions) {
  if (!newExpressions) return;

  var keys = Object.keys(STATE.smoothedEmotions);
  for (var i = 0; i < keys.length; i++) {
    var key    = keys[i];
    var newVal = newExpressions[key] || 0;
    STATE.smoothedEmotions[key] = lerp(
      STATE.smoothedEmotions[key], newVal, 1 - CONFIG.EMOTION_SMOOTH
    );
  }

  var frameWinner = 'neutral', frameMax = 0;
  for (var k in newExpressions) {
    if (newExpressions[k] > frameMax) { frameMax = newExpressions[k]; frameWinner = k; }
  }

  STATE.emotionVoteHistory.push(frameMax > 0.45 ? frameWinner : 'neutral');
  if (STATE.emotionVoteHistory.length > CONFIG.EMOTION_VOTE_WINDOW)
    STATE.emotionVoteHistory.shift();

  var votes = {};
  for (var j = 0; j < STATE.emotionVoteHistory.length; j++) {
    var e = STATE.emotionVoteHistory[j];
    votes[e] = (votes[e] || 0) + 1;
  }
  var voteWinner = 'neutral', voteMax = 0;
  for (var ek in votes) {
    if (votes[ek] > voteMax) { voteMax = votes[ek]; voteWinner = ek; }
  }
  if (voteMax / STATE.emotionVoteHistory.length >= CONFIG.EMOTION_VOTE_THRESHOLD)
    STATE.confirmedEmotion = voteWinner;

  STATE.currentEmotion    = STATE.confirmedEmotion;
  STATE.emotionConfidence = STATE.smoothedEmotions[STATE.currentEmotion] || 0;
}

function emotionToFocusComponent(emotion, confidence) {
  var scores = { neutral:80, happy:85, surprised:70, sad:35, angry:30, fearful:30, disgusted:25 };
  var base = scores[emotion] || 50;
  return clamp(base * confidence + 50 * (1 - confidence), 0, 100);
}


// ─────────────────────────────────────────────────────────────
// 8. METRICS ENGINE  — ★ FIX: thr is now always defined ★
// ─────────────────────────────────────────────────────────────
function computeMetrics(keypoints) {
  var now = performance.now();

  // ── Always read the current threshold from STATE ──────────
  var thr = STATE.earThreshold;    // ← THE FIX — was undefined before

  // EAR
  var rPts = getKPGroup(keypoints, LM.RIGHT_EYE);
  var lPts = getKPGroup(keypoints, LM.LEFT_EYE);
  var earR = rPts ? calcEAR(rPts) : STATE.lastEAR;
  var earL = lPts ? calcEAR(lPts) : STATE.lastEAR;
  var ear  = (earR + earL) / 2;
  STATE.lastEAR = ear;

  if (STATE.calibrating) {
    runCalibration(ear);
    return {
      ear: Math.round(ear * 1000) / 1000,
      earOpen: true, blinks: 0, bpm: 0, bpmReady: false,
      tiltAngle: 0, nodAngle: 0, focusScore: 50,
      feedback: '👀 Keep eyes OPEN — calibrating to your face...',
      calibrating: true,
    };
  }

  // ── Blink state machine — now uses correctly-scoped thr ──
  if (ear < thr) {
    STATE.blinkFrameCount++;
    if (STATE.blinkState === 'OPEN' && STATE.blinkFrameCount >= 2) {
      STATE.blinkState = 'CLOSING';
    }
    if (STATE.blinkState === 'CLOSING' && STATE.blinkFrameCount >= CONFIG.BLINK_FRAMES) {
      STATE.blinkState = 'CLOSED';
    }
  } else {
    if (STATE.blinkState === 'CLOSED' ||
       (STATE.blinkState === 'CLOSING' && STATE.blinkFrameCount >= CONFIG.BLINK_FRAMES)) {
      STATE.blinkTotal++;
    }
    STATE.blinkState      = 'OPEN';
    STATE.blinkFrameCount = 0;
  }

  // BPM
  var elapsedMs  = now - STATE.sessionStart;
  var elapsedMin = elapsedMs / 60000;
  var bpm = (elapsedMs > 15000 && elapsedMin > 0)
    ? Math.round(STATE.blinkTotal / elapsedMin) : 0;

  // Head pose
  var lT = getKP(keypoints, LM.LEFT_TEMPLE);
  var rT = getKP(keypoints, LM.RIGHT_TEMPLE);
  var nT = getKP(keypoints, LM.NOSE_TIP);
  var nB = getKP(keypoints, LM.NOSE_BRIDGE);
  var tiltAngle = (lT && rT) ? angleDeg(lT, rT) : 0;
  var nodAngle  = (nT && nB) ? (angleDeg(nB, nT) - 90) : 0;
  STATE.headTiltAngle = tiltAngle;
  STATE.headNodAngle  = nodAngle;

  // Focus score
  var earRange  = STATE.earBaseline - thr;
  var earScore  = earRange > 0.001
    ? clamp((ear - thr) / earRange * 100, 0, 100)
    : clamp((ear - 0.10) / 0.15 * 100, 0, 100);

  var blinkScore = bpm === 0 ? 70 :
    bpm >= 8 && bpm <= 25 ? clamp(100 - Math.abs(bpm - CONFIG.NORMAL_BPM) * 3, 50, 100) :
    bpm > 25 ? clamp(100 - (bpm - 25) * 4, 0, 50) :
    clamp(bpm * 8, 0, 50);

  var tiltPen   = clamp(Math.abs(tiltAngle) / CONFIG.TILT_THRESHOLD * 40, 0, 40);
  var nodPen    = clamp(Math.abs(nodAngle)  / CONFIG.NOD_THRESHOLD  * 40, 0, 40);
  var headScore = clamp(100 - tiltPen - nodPen, 0, 100);
  var emotionScore = emotionToFocusComponent(STATE.currentEmotion, STATE.emotionConfidence);

  var rawFocus = earScore   * CONFIG.W_EAR   +
                 blinkScore * CONFIG.W_BLINK +
                 headScore  * CONFIG.W_HEAD  +
                 emotionScore * CONFIG.W_EMOTION;

  STATE.smoothFocus = lerp(STATE.smoothFocus, rawFocus, CONFIG.SMOOTH);

  return {
    ear:        Math.round(ear * 1000) / 1000,
    earOpen:    ear >= thr,
    blinks:     STATE.blinkTotal,
    bpm:        bpm,
    bpmReady:   elapsedMs > 15000,
    tiltAngle:  Math.round(tiltAngle * 10) / 10,
    nodAngle:   Math.round(nodAngle  * 10) / 10,
    focusScore: Math.round(STATE.smoothFocus),
    feedback:   makeFeedback(ear, bpm, tiltAngle, nodAngle,
                  STATE.smoothFocus, elapsedMs, thr,
                  STATE.currentEmotion, STATE.emotionConfidence),
    calibrating: false,
  };
}


// ─────────────────────────────────────────────────────────────
// 9. SMART FEEDBACK
// ─────────────────────────────────────────────────────────────
function makeFeedback(ear, bpm, tilt, nod, focus, elapsed, thr, emotion, conf) {
  if (elapsed < 5000) return '⏳ Warming up — hold still...';

  if (conf > 0.6) {
    if (emotion === 'happy')     return '😊 You look happy and engaged — great energy!';
    if (emotion === 'angry')     return '😠 You look tense. Take a breath and relax your face.';
    if (emotion === 'sad')       return '😔 You seem a bit down. Is everything okay?';
    if (emotion === 'fearful')   return '😨 You look anxious. Try relaxing your jaw and shoulders.';
    if (emotion === 'disgusted') return '🤢 Something bothering you? Try to refocus.';
    if (emotion === 'surprised') return '😲 Something caught your attention!';
  }

  if (ear < thr * 0.65)      return '😴 Eyes nearly closed — are you falling asleep?';
  if (bpm > 35)              return '😰 Very high blink rate (' + bpm + '/min) — stress or fatigue.';
  if (Math.abs(nod) > 20)   return '😪 Head drooping — drowsiness detected.';
  if (ear < thr && bpm > 22) return '🥱 Heavy eyes + frequent blinking — take a break soon.';
  if (Math.abs(tilt) > CONFIG.TILT_THRESHOLD)
    return '↗ Head tilted ' + (tilt > 0 ? 'right' : 'left') + ' — try sitting upright.';
  if (bpm > 22)              return '😓 Blink rate above normal (' + bpm + '/min) — early fatigue.';
  if (bpm > 0 && bpm < 5)   return '👁 Very low blink rate — eyes may be strained.';

  if (focus >= 80) return '🎯 Highly focused — excellent posture, eyes open, calm expression.';
  if (focus >= 60) return '✅ Focused and attentive. Keep it up!';
  if (focus >= 40) return '🙂 Moderate focus — looking good.';
  return '💡 Sit upright and face the camera directly for best results.';
}


// ─────────────────────────────────────────────────────────────
// 10. MODEL LOADING
// ─────────────────────────────────────────────────────────────
async function loadModels() {
  updateEl('tf-status', 'Initialising...');
  try {
    await tf.setBackend('webgl');
    await tf.ready();
    updateEl('tf-status', 'Ready (WebGL)');

    updateEl('emotion-model-status', 'Loading...');
    setStatus('Loading emotion model (~2MB)...', 'waiting');

    var MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model';
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    await faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL);
    STATE.emotionModelReady = true;
    updateEl('emotion-model-status', 'Ready');
    if (DOM.emotionStatus) DOM.emotionStatus.textContent = 'Ready — start detection';

    updateEl('model-status', 'Loading...');
    setStatus('Loading face mesh model...', 'waiting');

    STATE.meshModel = await faceLandmarksDetection.createDetector(
      faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh,
      {
        runtime:         'mediapipe',
        solutionPath:    'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619',
        maxFaces:        1,
        refineLandmarks: false,
      }
    );

    updateEl('model-status', 'Ready');
    setStatus('All models ready — tap Start Detection!', 'waiting');
    DOM.startBtn.disabled    = false;
    DOM.startBtn.textContent = 'Start Detection';
    return true;

  } catch (err) {
    setStatus('Model load error: ' + err.message, 'error');
    console.error('Model load failed:', err);
    if (STATE.meshModel) {
      DOM.startBtn.disabled    = false;
      DOM.startBtn.textContent = 'Start (limited)';
    }
    return false;
  }
}

async function startCamera() {
  setStatus('Requesting camera permission...', 'waiting');
  try {
    var stream = await navigator.mediaDevices.getUserMedia({
      video: { width:{ideal:640}, height:{ideal:480}, facingMode:'user' },
      audio: false,
    });
    DOM.video.srcObject = stream;
    await new Promise(function(r){ DOM.video.addEventListener('loadedmetadata', r, {once:true}); });
    await new Promise(function(r){ DOM.video.addEventListener('canplay', r, {once:true}); });
    DOM.canvas.width  = DOM.video.videoWidth;
    DOM.canvas.height = DOM.video.videoHeight;
    return true;
  } catch (err) {
    setStatus('Camera error: ' + err.message, 'error');
    return false;
  }
}


// ─────────────────────────────────────────────────────────────
// 11. DETECTION LOOP
// ─────────────────────────────────────────────────────────────
async function detectionLoop() {
  if (!STATE.isRunning) return;
  var now = performance.now();

  // Throttle: 20fps mobile, 60fps desktop
  var isMobile = window.innerWidth <= 768 ||
                 /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  var minFrameMs = isMobile ? 50 : 16;

  if (now - STATE.lastDetectionTime < minFrameMs) {
    STATE.animFrameId = requestAnimationFrame(detectionLoop);
    return;
  }
  STATE.lastDetectionTime = now;

  try {
    if (DOM.video.readyState < 2 || DOM.video.videoWidth === 0) {
      STATE.animFrameId = requestAnimationFrame(detectionLoop);
      return;
    }
    if (DOM.canvas.width  !== DOM.video.videoWidth ||
        DOM.canvas.height !== DOM.video.videoHeight) {
      DOM.canvas.width  = DOM.video.videoWidth;
      DOM.canvas.height = DOM.video.videoHeight;
    }

    var displayW = DOM.canvas.offsetWidth  || DOM.canvas.width;
    var displayH = DOM.canvas.offsetHeight || DOM.canvas.height;
    STATE.scaleX = DOM.canvas.width  / displayW;
    STATE.scaleY = DOM.canvas.height / displayH;

    var faces = await STATE.meshModel.estimateFaces(DOM.video, { flipHorizontal: false });
    CTX.clearRect(0, 0, DOM.canvas.width, DOM.canvas.height);

    if (faces && faces.length > 0 && faces[0].keypoints && faces[0].keypoints.length > 0) {
      var pts = faces[0].keypoints;
      drawFaceMesh(pts);
      var m = computeMetrics(pts);
      updatePanel(true, pts.length);
      updateMetrics(m);
    } else {
      updatePanel(false, 0);
      if (!STATE.calibrating && DOM.feedbackText)
        DOM.feedbackText.textContent = '👤 No face detected — move closer to the camera.';
    }

    // Emotion detection — fire and forget (fixes Android hang)
    STATE.framesSinceEmotion++;
    if (STATE.framesSinceEmotion >= CONFIG.EMOTION_EVERY_N_FRAMES &&
        !STATE.calibrating && STATE.emotionModelReady) {
      STATE.framesSinceEmotion = 0;
      detectEmotions().then(function(expressions) {
        if (expressions) {
          smoothEmotions(expressions);
          updateEmotionPanel();
        }
      });
    }

  } catch (err) {
    console.warn('Frame error:', err.message);
  }

  // FPS counter
  STATE.frameCount++;
  if (now - STATE.lastFrameTime >= CONFIG.FPS_INTERVAL) {
    var fps = Math.round((STATE.frameCount * 1000) / (now - STATE.lastFrameTime));
    if (DOM.fpsValue) DOM.fpsValue.textContent = fps + ' fps';
    STATE.frameCount    = 0;
    STATE.lastFrameTime = now;
  }

  STATE.animFrameId = requestAnimationFrame(detectionLoop);
}


// ─────────────────────────────────────────────────────────────
// 12. DRAWING — cleaner, no messy arrows
// ─────────────────────────────────────────────────────────────
function drawFaceMesh(kpts) {
  CTX.save();

  // All 468 dots — small, clean
  CTX.fillStyle = CONFIG.DOT_COLOR;
  for (var i = 0; i < kpts.length; i++) {
    CTX.beginPath();
    CTX.arc(kpts[i].x, kpts[i].y, CONFIG.DOT_RADIUS, 0, Math.PI * 2);
    CTX.fill();
  }

  // Eye dots — highlighted in accent red
  var eyeIdx = LM.RIGHT_EYE.concat(LM.LEFT_EYE);
  CTX.fillStyle = CONFIG.EYE_DOT_COLOR;
  for (var j = 0; j < eyeIdx.length; j++) {
    var p = kpts[eyeIdx[j]];
    if (p) {
      CTX.beginPath();
      CTX.arc(p.x, p.y, CONFIG.EYE_DOT_RADIUS, 0, Math.PI * 2);
      CTX.fill();
    }
  }

  CTX.restore();
}

function drawBox(box) {
  if (!box) return;
  var x = box.xMin, y = box.yMin;
  var w = box.width  || (box.xMax - box.xMin);
  var h = box.height || (box.yMax - box.yMin);
  if (!w || !h) return;
  CTX.save();
  CTX.strokeStyle = CONFIG.BOX_COLOR;
  CTX.lineWidth   = 1.5;
  CTX.setLineDash([6, 4]);
  CTX.strokeRect(x - 8, y - 8, w + 16, h + 16);
  CTX.restore();
}


// ─────────────────────────────────────────────────────────────
// 13. UI UPDATES
// ─────────────────────────────────────────────────────────────
function setStatus(msg, type) {
  if (DOM.statusText) DOM.statusText.textContent = msg;
  if (DOM.statusDot)  DOM.statusDot.className    = 'dot dot--' + type;
}

function updateEl(id, text) {
  var el = document.getElementById(id);
  if (el) el.textContent = text;
}

function updatePanel(found, count) {
  var fd = document.getElementById('face-detected');
  var lc = document.getElementById('landmark-count');
  if (found) {
    if (fd) { fd.textContent = 'Yes'; fd.className = 'stat-value val-good'; }
    if (lc) { lc.textContent = count; lc.className = 'stat-value val-accent'; }
  } else {
    if (fd) { fd.textContent = 'No'; fd.className = 'stat-value val-bad'; }
    if (lc) { lc.textContent = '0';  lc.className = 'stat-value'; }
  }
}

var timerInterval = null;

function startSessionTimer() {
  var timerEl   = document.getElementById('timer-value');
  var timerWrap = document.getElementById('session-timer');
  var liveEl    = document.getElementById('live-dot');
  var liveLabel = document.getElementById('live-label');
  if (timerWrap) timerWrap.style.display = 'flex';
  if (liveEl)    liveEl.className = 'live-dot active';
  if (liveLabel) liveLabel.textContent = 'Live';

  timerInterval = setInterval(function() {
    if (!STATE.isRunning) { clearInterval(timerInterval); return; }
    var elapsed = Math.floor((performance.now() - STATE.sessionStart) / 1000);
    var mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    var ss = String(elapsed % 60).padStart(2, '0');
    if (timerEl) timerEl.textContent = mm + ':' + ss;
  }, 1000);
}

function stopSessionTimer() {
  if (timerInterval) clearInterval(timerInterval);
  var timerWrap = document.getElementById('session-timer');
  var liveEl    = document.getElementById('live-dot');
  var liveLabel = document.getElementById('live-label');
  if (timerWrap) timerWrap.style.display = 'none';
  if (liveEl)    liveEl.className = 'live-dot';
  if (liveLabel) liveLabel.textContent = 'Offline';
}

function updateFocusRing(score) {
  var ring  = document.getElementById('focus-ring-fill');
  var num   = document.getElementById('focus-score');
  var badge = document.getElementById('focus-score-badge');
  if (!ring) return;
  var circumference = 2 * Math.PI * 50;
  var offset = circumference - (score / 100) * circumference;
  ring.style.strokeDashoffset = offset;
  ring.style.stroke = score >= 70 ? '#00e5ff' : score >= 40 ? '#ffd740' : '#ff5252';
  if (num)   num.textContent   = score;
  if (badge) badge.textContent = score + ' / 100';
}

function updateMetrics(m) {
  var earTile = document.getElementById('ear-value');
  if (earTile) {
    earTile.textContent = m.calibrating ? 'calibrating' : m.ear.toFixed(3);
    earTile.className   = 'metric-tile-value ' + (m.earOpen ? 'val-accent' : 'val-warn');
  }
  var bc = document.getElementById('blink-count');
  if (bc) bc.textContent = m.blinks;

  var br = document.getElementById('blink-rate');
  if (br) {
    br.textContent = m.calibrating ? '—' : !m.bpmReady ? '...' : m.bpm;
    br.className   = 'metric-tile-value ' + (m.bpm > 25 || (m.bpm > 0 && m.bpm < 5) ? 'val-warn' : 'val-accent');
  }
  var ht = document.getElementById('head-tilt');
  if (ht) {
    var ta = Math.abs(m.tiltAngle);
    ht.textContent = ta < 3 ? 'Level' : (m.tiltAngle > 0 ? '→ ' : '← ') + ta.toFixed(1) + '°';
    ht.className   = 'metric-tile-value ' + (ta > CONFIG.TILT_THRESHOLD ? 'val-warn' : 'val-good');
  }
  var hn = document.getElementById('head-nod');
  if (hn) {
    var na = Math.abs(m.nodAngle);
    hn.textContent = na < 5 ? 'Level' : (m.nodAngle > 0 ? '↓ ' : '↑ ') + na.toFixed(1) + '°';
    hn.className   = 'metric-tile-value ' + (na > CONFIG.NOD_THRESHOLD ? 'val-warn' : 'val-good');
  }
  updateFocusRing(m.focusScore);

  var vosEar    = document.getElementById('vos-ear');
  var vosFocus  = document.getElementById('vos-focus');
  var vosBlinks = document.getElementById('vos-blinks');
  if (vosEar)    vosEar.textContent    = m.ear.toFixed(3);
  if (vosFocus)  vosFocus.textContent  = m.focusScore;
  if (vosBlinks) vosBlinks.textContent = m.blinks;

  var fb = document.getElementById('feedback-text');
  if (fb) fb.textContent = m.feedback;
}

function updateEmotionPanel() {
  var emotions = STATE.smoothedEmotions;
  var current  = STATE.currentEmotion;
  var conf     = STATE.emotionConfidence;
  var cfg      = EMOTION_CONFIG[current] || { emoji: '😐', label: current };

  if (DOM.emotionEmoji) DOM.emotionEmoji.textContent = cfg.emoji;
  if (DOM.emotionName)  DOM.emotionName.textContent  = cfg.label;
  if (DOM.emotionConf)  DOM.emotionConf.textContent  = Math.round(conf * 100) + '% confidence';
  if (DOM.emotionStatus) DOM.emotionStatus.textContent = '';

  var keys = ['happy', 'neutral', 'sad', 'angry', 'surprised', 'fearful', 'disgusted'];
  for (var i = 0; i < keys.length; i++) {
    var key   = keys[i];
    var val   = emotions[key] || 0;
    var pct   = Math.round(val * 100);
    var bar   = document.getElementById('bar-' + key);
    var pctEl = document.getElementById('pct-' + key);
    if (bar)   bar.style.width   = pct + '%';
    if (pctEl) pctEl.textContent = pct + '%';
    if (bar)   bar.style.opacity = (key === current && conf > CONFIG.EMOTION_MIN_CONFIDENCE) ? '1' : '0.45';
  }
}


// ─────────────────────────────────────────────────────────────
// 14. ENTRY POINT
// ─────────────────────────────────────────────────────────────
async function init() {
  console.log('Face AI Tracker — initialising...');
  DOM.startBtn.disabled    = true;
  DOM.startBtn.textContent = 'Loading...';
  await loadModels();

  DOM.startBtn.addEventListener('click', async function() {
    DOM.startBtn.disabled = true;

    if (!STATE.isRunning) {
      var ok = await startCamera();
      if (!ok) { DOM.startBtn.disabled = false; return; }
      if (!STATE.meshModel) {
        setStatus('Models not loaded. Refresh the page.', 'error');
        DOM.startBtn.disabled = false;
        return;
      }

      // Full reset
      STATE.blinkState         = 'OPEN';
      STATE.blinkFrameCount    = 0;
      STATE.blinkTotal         = 0;
      STATE.sessionStart       = performance.now();
      STATE.smoothFocus        = 50;
      STATE.isRunning          = true;
      STATE.lastFrameTime      = performance.now();
      STATE.frameCount         = 0;
      STATE.calibDone          = false;
      STATE.framesSinceEmotion = 0;
      // Reset threshold to fallback before calibration overrides it
      STATE.earThreshold       = CONFIG.EAR_FALLBACK;
      CHAT.history             = [];
      CHAT.rateLimitedUntil    = 0;
      CHAT.lastUserMessageTime = 0;
      CHAT.consecutiveErrors   = 0;
      var ekeys = Object.keys(STATE.smoothedEmotions);
      for (var i = 0; i < ekeys.length; i++) STATE.smoothedEmotions[ekeys[i]] = 0;
      STATE.smoothedEmotions.neutral = 0.5;
      STATE.emotionVoteHistory = [];
      STATE.confirmedEmotion   = 'neutral';

      startCalibration();
      startSessionTimer();
      startAutoAnalysis();

      var vos = document.getElementById('video-overlay-stats');
      if (vos) vos.style.display = 'flex';

      DOM.startBtn.textContent = 'Stop';
      DOM.startBtn.className   = 'btn-primary btn-stop';
      DOM.startBtn.disabled    = false;
      detectionLoop();

    } else {

      STATE.isRunning = false;
      stopSessionTimer();
      stopAutoAnalysis();
      if (STATE.animFrameId) cancelAnimationFrame(STATE.animFrameId);
      if (DOM.video.srcObject) {
        DOM.video.srcObject.getTracks().forEach(function(t){ t.stop(); });
        DOM.video.srcObject = null;
      }
      if (DOM.calibStatus) DOM.calibStatus.style.display = 'none';

      var vos = document.getElementById('video-overlay-stats');
      if (vos) vos.style.display = 'none';

      CTX.clearRect(0, 0, DOM.canvas.width, DOM.canvas.height);
      setStatus('Stopped. Tap Start to run again.', 'waiting');
      DOM.startBtn.textContent = 'Start Detection';
      DOM.startBtn.className   = 'btn-primary';
      DOM.startBtn.disabled    = false;
      updatePanel(false, 0);
      updateFocusRing(0);
      if (DOM.fpsValue) DOM.fpsValue.textContent = '—';

      // ── Show feedback modal when session was long enough ──
      var sessionMs = STATE.sessionStart
        ? performance.now() - STATE.sessionStart : 0;
      if (sessionMs >= FEEDBACK.minSessionMs) {
        // Small delay so the UI settles before modal appears
        setTimeout(showFeedbackModal, 600);
      }
    }
  });
}


// ═══════════════════════════════════════════════════════════════
// PHASE 5 — AI CHAT SYSTEM
// ═══════════════════════════════════════════════════════════════
var CHAT = {
  SERVER_URL:          'https://face-ai-tracker.onrender.com',
  AUTO_INTERVAL_MS:    120000,
  serverOnline:        false,
  autoTimer:           null,
  history:             [],
  isWaiting:           false,
  rateLimitedUntil:    0,
  lastUserMessageTime: 0,
  consecutiveErrors:   0,
};

async function checkServer() {
  try {
    var res = await fetch(CHAT.SERVER_URL + '/health', {
      method: 'GET',
      signal: AbortSignal.timeout(35000),
    });
    if (res.ok) {
      CHAT.serverOnline = true;
      updateServerStatus(true);
      updateChatStatusText('Server connected');
      return true;
    }
  } catch (e) {}
  CHAT.serverOnline = false;
  updateServerStatus(false);
  updateChatStatusText('Server offline');
  return false;
}

function updateServerStatus(online) {
  var dot  = document.getElementById('chat-server-dot');
  var text = document.getElementById('chat-status-text');
  var srv  = document.getElementById('server-status');
  if (dot)  dot.className  = 'chat-server-dot ' + (online ? 'dot-online' : 'dot-offline');
  if (text) text.textContent = online ? 'Server connected' : 'Server offline';
  if (srv)  { srv.textContent = online ? 'Connected' : 'Offline'; srv.className = 'stat-value ' + (online ? 'val-good' : 'val-bad'); }
}

function collectFaceData() {
  var now        = performance.now();
  var elapsed    = now - STATE.sessionStart;
  var elapsedMin = elapsed / 60000;
  var bpm = (elapsed > 15000 && elapsedMin > 0)
    ? Math.round(STATE.blinkTotal / elapsedMin) : 0;
  return {
    emotion:           STATE.currentEmotion,
    emotionConfidence: STATE.emotionConfidence,
    focusScore:        Math.round(STATE.smoothFocus),
    blinkRate:         bpm,
    blinkCount:        STATE.blinkTotal,
    ear:               Math.round(STATE.lastEAR * 1000) / 1000,
    headTilt:          Math.round(STATE.headTiltAngle * 10) / 10,
    headNod:           Math.round(STATE.headNodAngle  * 10) / 10,
    sessionMs:         elapsed,
  };
}

function startAutoAnalysis() {
  stopAutoAnalysis();
  CHAT.autoTimer = setInterval(async function() {
    var toggle = document.getElementById('auto-analyze-toggle');
    if (!toggle || !toggle.checked) return;
    if (!STATE.isRunning || STATE.calibrating) return;
    if (!CHAT.serverOnline) { await checkServer(); return; }
    await runAnalysis();
  }, CHAT.AUTO_INTERVAL_MS);
}

function stopAutoAnalysis() {
  if (CHAT.autoTimer) { clearInterval(CHAT.autoTimer); CHAT.autoTimer = null; }
}

// ─────────────────────────────────────────────────────────────
// LOCAL ARIA AI ENGINE
// ─────────────────────────────────────────────────────────────
var AI = {
  observationCount:  0,
  lastEmotionSeen:   null,
  conversationDepth: 0,
  lastTopic:         null,

  observe: function(d) {
    var emotion = d.emotion    || 'neutral';
    var focus   = d.focusScore || 0;
    var bpm     = d.blinkRate  || 0;
    var ear     = d.ear        || 0;
    var nod     = Math.abs(d.headNod  || 0);
    var tilt    = Math.abs(d.headTilt || 0);
    var mins    = Math.round((d.sessionMs || 0) / 60000);
    var conf    = d.emotionConfidence || 0;
    var thr     = STATE.earThreshold || 0.15;

    if (ear < thr * 0.65 || nod > 22)
      return "I can see your eyes are very heavy right now. Your body is telling you something important — you need rest. Can you take even 5 minutes to close your eyes?";
    if (bpm > 32)
      return "Your blink rate is quite high — " + bpm + " times per minute. That's a sign your eyes and nervous system are under strain. Take a slow breath with me.";
    if (emotion === 'angry' && conf > 0.5)
      return "I can see tension in your expression. Something is frustrating you — and that's valid. Try unclenching your jaw, rolling your shoulders back, and taking one deep breath. What's on your mind?";
    if (emotion === 'sad' && conf > 0.5)
      return "I notice you look a little low right now. I'm here if you want to talk — no pressure. How are you really doing?";
    if (emotion === 'fearful' && conf > 0.5)
      return "Your expression is showing some anxiety. Try grounding yourself: name 5 things you can see right now. Want to talk about what's weighing on you?";
    if (emotion === 'happy' && conf > 0.6 && focus >= 70)
      return "You look genuinely happy and focused — " + focus + "/100. This is your peak state. Whatever you're working on, push forward. You've been at it " + mins + " minutes.";
    if (focus >= 80) return "You're in deep focus — " + focus + "/100. Eyes open, posture steady, expression calm. This is optimal performance. Protect this state.";
    if (focus >= 60) return "Good focus at " + focus + "/100" + (bpm > 0 ? " with a blink rate of " + bpm + "/min." : ".") + " You're doing well.";
    if (focus < 40)  return "Your focus has dipped to " + focus + "/100. A complete 5-minute break now will make the next hour sharper. How are you feeling?";
    if (mins >= 50)  return "You've been working for nearly an hour. A 10-minute real break now will make the next hour sharper. How are you feeling?";
    if (tilt > 12)   return "I notice your head is tilted " + Math.round(tilt) + "° — this often happens when we're uncertain or distracted. Try sitting upright.";
    AI.observationCount++;
    return "You look calm and present. Focus at " + focus + "/100" + (bpm > 0 ? ", blink rate " + bpm + "/min" : "") + ". " + (mins > 0 ? mins + " minutes in — keep going." : "Getting started — you've got this.");
  },

  answer: function(question, d) {
    var q       = question.toLowerCase().trim();
    var emotion = d.emotion    || 'neutral';
    var focus   = d.focusScore || 0;
    var bpm     = d.blinkRate  || 0;
    var ear     = d.ear        || 0;
    var mins    = Math.round((d.sessionMs || 0) / 60000);
    var conf    = d.emotionConfidence || 0;
    AI.conversationDepth++;

    if (q.match(/^(hi|hello|hey|good morning|good evening|good afternoon|howdy|what'?s up|sup)\b/)) {
      return "Hello! I'm Aria, your wellness coach. You're looking " + emotion + " with focus at " + focus + "/100. How are you feeling today?";
    }
    if (q.match(/don'?t feel (good|well|great|okay|fine)|feel (bad|terrible|awful|horrible|low|down|off|weird)|feeling (bad|terrible|low|down|off|rough)/)) {
      AI.lastTopic = 'feeling-bad';
      return "I hear you — and I'm glad you said something. 💙\n\nCan you tell me more about what's going on? Is it more physical — like tired, drained? Or emotional — something weighing on your mind or heart?";
    }
    if (q.match(/marital|marriage|husband|wife|partner|relationship|divorce|breakup/)) {
      AI.lastTopic = 'relationship';
      return "That sounds really painful. Relationship stress is one of the most draining things a person can go through.\n\nWhat feels most overwhelming about it right now? Is it the conflict, the uncertainty, or the exhaustion of it all?";
    }
    if (q.match(/exhaust|burnout|burn.?out|drained|depleted|no energy|too much|overwhelm/)) {
      AI.lastTopic = 'burnout';
      return "Exhaustion at this level is your mind and body sending a serious signal. This isn't weakness — your system has been running on empty for too long.\n\nHow long have you been feeling this way? And is there one main thing draining you, or is it everything at once?";
    }
    if (q.match(/anxious|anxiety|panic|fear|scared|nervous|worry|worried|overthink/)) {
      AI.lastTopic = 'anxiety';
      return "What you're describing is genuinely exhausting — when the mind is constantly scanning for threat, even rest doesn't feel like rest.\n\nRight now, look around and name 5 things you can physically see. This is called grounding and it anchors your nervous system to the present moment.\n\nHow long have you been feeling this way?";
    }
    if (q.match(/depress|depressed|hopeless|empty|numb|worthless|nothing matters/)) {
      AI.lastTopic = 'depression';
      return "Thank you for trusting me with this. What you're describing sounds really painful.\n\nI want to be honest: I'm an AI, and what you're feeling may need more support than I alone can give. A real therapist can help in ways I can't.\n\nBut I'm here with you right now. Can you tell me when this started?";
    }
    if (q.match(/suicid|kill myself|end it|don'?t want to (be here|live|exist)|want to die/)) {
      AI.lastTopic = 'crisis';
      return "I hear you, and what you're feeling right now matters deeply.\n\nPlease reach out to someone who can really be there for you:\n\n🆘 Crisis Text Line: Text HOME to 741741\n📞 International: findahelpline.com\n\nYou deserve real human support. Is there someone near you right now you could call or be with?";
    }
    if (q.match(/lost my (mom|mother|dad|father|sister|brother|son|daughter|wife|husband|partner|friend|pet|dog|cat)|passed away|she died|he died|they died|funeral|mourning|grieving/)) {
      AI.lastTopic = 'grief';
      return "I am so deeply sorry for your loss. Losing someone you love is one of the most painful experiences a person can go through — and there are no words that make it better.\n\nI'm here with you right now. Do you want to tell me about them?";
    }
    if (q.match(/lonely|alone|isolated|no one|nobody|no friends/)) {
      AI.lastTopic = 'loneliness';
      return "Loneliness is one of the most painful human experiences — and it's more common than people admit.\n\nI see you. You reached out, and that matters.\n\nIs this a new feeling, or has it been there a while?";
    }
    if (q.match(/meditat|mindful|calm down|relax|breathing|breath/)) {
      AI.lastTopic = 'mindfulness';
      return "Right now, try this with me:\n\n1. Breathe in through your nose for 4 counts\n2. Hold for 4 counts\n3. Out through your mouth for 6 counts\n\nDo that twice. When the mind is scattered, breathing is the fastest way back to the present moment. How do you feel after?";
    }
    if (q.match(/sleep|insomnia|can'?t sleep|wake up|tired|rest/)) {
      AI.lastTopic = 'sleep';
      return "Sleep issues affect everything — mood, focus, relationships, physical health.\n\nIs it trouble falling asleep, staying asleep, or waking too early? And what's typically going through your mind when you can't sleep?";
    }
    if (q.match(/focus|concentrat|distract|productiv|motivation|procrastinat/)) {
      AI.lastTopic = 'focus';
      return "Focus struggles are almost never about willpower — they're usually about mental overload, unclear priorities, or an environment fighting against you.\n\nYour current focus score is " + focus + "/100. When you try to focus, what actually happens? Does your mind wander, do you get pulled to your phone, or do you feel mentally foggy?";
    }
    if (q.match(/thank|thanks|helpful|appreciate|that helped|feel better/)) {
      return "I'm really glad that helped. 😊\n\nYou did the hard part — you showed up and were honest. Take care of yourself.";
    }
    if (q.match(/who are you|what are you|your name|aria|about you/)) {
      return "I'm Aria — an AI wellness coach built into Face AI Tracker.\n\nI can actually see your face in real time — reading your emotions, eye fatigue, focus level, and posture. I use that to personalise every response.\n\nI'm not a replacement for a therapist. But I'm always here, never judge, and genuinely want to help. What would you like to talk about?";
    }
    if (q.match(/test|testing|is this working|can you hear/)) {
      return "Yes, I'm here and working!\n\n• Emotion: " + emotion + " (" + Math.round(conf * 100) + "% confidence)\n• Focus: " + focus + "/100\n• Eye openness: " + ear.toFixed(3) + "\n• Blink rate: " + (bpm > 0 ? bpm + "/min" : "measuring...") + "\n• Session: " + mins + " min\n\nEverything is running. Talk to me about anything.";
    }

    var fallbacks = [
      "I want to make sure I understand you properly. Can you tell me a bit more about what you mean?",
      "That's interesting — say more. What's behind that for you?",
      "I hear you. What's the main thing you want help with right now — something you're feeling, thinking, or want to do differently?",
      "Can you share a bit more context? I want to give you a useful response, not a generic one.",
    ];
    return fallbacks[Math.floor(AI.conversationDepth % fallbacks.length)];
  },
};


async function runAnalysis() {
  if (CHAT.isWaiting) return;
  if (CHAT.rateLimitedUntil > performance.now()) return;
  CHAT.isWaiting = true;
  showTypingIndicator();
  var faceData = collectFaceData();
  var response = null;

  if (CHAT.serverOnline) {
    try {
      var res = await fetch(CHAT.SERVER_URL + '/analyze', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(faceData),
        signal:  AbortSignal.timeout(15000),
      });
      var data = await res.json();
      if (res.ok && data.response) response = data.response;
      else if (res.status === 429) CHAT.rateLimitedUntil = performance.now() + 3600000;
    } catch (e) { console.warn('[auto-analyse] server error, using local'); }
  }

  if (!response) { response = AI.observe(faceData); AI.observationCount++; }
  removeTypingIndicator();

  var lastUserTime = CHAT.lastUserMessageTime || 0;
  if (performance.now() - lastUserTime > 30000) {
    addChatMessage('ai', response);
    CHAT.history.push({ role: 'assistant', content: response });
    if (CHAT.history.length > 20) CHAT.history.shift();
  }
  CHAT.isWaiting = false;
}

function updateChatStatusText(text) {
  var el = document.getElementById('chat-status-text');
  if (el) el.textContent = text;
}

async function sendChatMessage() {
  var input = document.getElementById('chat-input');
  if (!input) return;
  var text = input.value.trim();
  if (!text || CHAT.isWaiting) return;
  input.value = '';
  input.style.height = 'auto';
  input.style.overflowY = 'hidden';
  addChatMessage('user', text);
  CHAT.lastUserMessageTime = performance.now();
  CHAT.history.push({ role: 'user', content: text });
  CHAT.isWaiting = true;
  showTypingIndicator();
  var faceData = collectFaceData();
  var response = null;

  if (CHAT.serverOnline && CHAT.rateLimitedUntil <= performance.now()) {
    try {
      var res = await fetch(CHAT.SERVER_URL + '/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ message: text, faceData: faceData, history: CHAT.history.slice(-12) }),
        signal:  AbortSignal.timeout(20000),
      });
      var data = await res.json();
      if (res.ok && data.response) response = data.response;
      else if (res.status === 429) CHAT.rateLimitedUntil = performance.now() + 3600000;
    } catch (e) {
      if (e.name === 'TypeError' || e.name === 'AbortError') {
        CHAT.serverOnline = false;
        updateServerStatus(false);
      }
    }
  }

  if (!response) response = AI.answer(text, faceData);
  removeTypingIndicator();
  addChatMessage('ai', response);
  CHAT.history.push({ role: 'assistant', content: response });
  if (CHAT.history.length > 20) CHAT.history.splice(0, 2);
  CHAT.isWaiting = false;
}

document.addEventListener('DOMContentLoaded', function() {
  var input = document.getElementById('chat-input');
  if (input) {
    input.addEventListener('input', function() {
      this.style.height = 'auto';
      var newHeight = Math.min(this.scrollHeight, 160);
      this.style.height = newHeight + 'px';
      this.style.overflowY = this.scrollHeight > 160 ? 'auto' : 'hidden';
    });
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
        this.style.height = 'auto';
        this.style.overflowY = 'hidden';
      }
    });
  }
});

function addChatMessage(role, text) {
  var container = document.getElementById('chat-messages');
  if (!container) return;
  var div = document.createElement('div');
  div.className = 'chat-msg chat-msg--' + role;
  var now  = new Date();
  var time = now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0');
  if (role === 'ai') {
    div.innerHTML =
      '<div class="chat-avatar">AI</div>' +
      '<div class="chat-bubble"><p>' + escapeHtml(text) + '</p>' +
      '<span class="chat-time">' + time + '</span></div>';
  } else if (role === 'user') {
    div.innerHTML =
      '<div class="chat-bubble chat-bubble--user"><p>' + escapeHtml(text) + '</p>' +
      '<span class="chat-time">' + time + '</span></div>';
  } else {
    div.innerHTML = '<p>' + text + '</p>';
  }
  container.appendChild(div);
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      setTimeout(function() {
        container.scrollTop = container.scrollHeight;
        div.scrollIntoView({ behavior: 'smooth', block: 'end' });
      }, 60);
    });
  });
}

function showTypingIndicator() {
  var container = document.getElementById('chat-messages');
  if (!container) return;
  var div = document.createElement('div');
  div.className = 'chat-msg chat-msg--ai';
  div.id        = 'typing-indicator';
  div.innerHTML =
    '<div class="chat-avatar">AI</div>' +
    '<div class="chat-bubble"><div class="typing-dots">' +
    '<span></span><span></span><span></span></div></div>';
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function removeTypingIndicator() {
  var el = document.getElementById('typing-indicator');
  if (el) el.remove();
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>');
}

// Check server on load
setTimeout(checkServer, 1000);
setInterval(checkServer, 30000);

// Keep-alive ping every 14 minutes
setInterval(function() {
  fetch(CHAT.SERVER_URL + '/health', { method:'GET', signal:AbortSignal.timeout(10000) })
    .catch(function(){});
}, 14 * 60 * 1000);

init();

// ── VISIBILITY HANDLER ─────────────────────────────────────
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'hidden') {
    var sessionMs = STATE.sessionStart ? performance.now() - STATE.sessionStart : 0;
    if (sessionMs >= 60000 && !FEEDBACK.shown) showFeedbackModal();
  }
  if (document.visibilityState === 'visible' && STATE.isRunning) {
    if (!DOM.video.srcObject ||
        DOM.video.srcObject.getTracks().every(function(t){ return t.readyState === 'ended'; })) {
      startCamera().then(function(ok){
        if (ok) setStatus('Detection running — look at the camera!', 'running');
      });
    }
  }
});

// ── KEYBOARD SCROLL FIX ────────────────────────────────────
(function() {
  var chatInput = document.getElementById('chat-input');
  if (!chatInput) return;
  chatInput.addEventListener('focus', function() {
    setTimeout(function() {
      chatInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 350);
  });
  chatInput.addEventListener('blur', function() {
    setTimeout(function() {
      window.scrollTo({ top: window.scrollY, behavior: 'instant' });
    }, 100);
  });
})();


// ═══════════════════════════════════════════════════════════════
// EXIT FEEDBACK SYSTEM
// ═══════════════════════════════════════════════════════════════
var FEEDBACK = {
  shown:        false,
  selectedStar: 0,
  minSessionMs: 60000,
};

function buildFeedbackModal() {
  if (document.getElementById('feedback-modal-overlay')) return;
  var overlay = document.createElement('div');
  overlay.id        = 'feedback-modal-overlay';
  overlay.className = 'feedback-modal-overlay';
  overlay.innerHTML = '<div class="feedback-modal" id="feedback-modal">' +
    '<div id="feedback-form-content">' +
    '<div class="feedback-modal-title">Before you go — how was your experience?</div>' +
    '<div class="feedback-modal-sub">Your feedback helps make Aria better for everyone.</div>' +
    '<div class="feedback-stars" id="feedback-stars">' +
    '<span class="feedback-star" data-value="1">⭐</span>' +
    '<span class="feedback-star" data-value="2">⭐</span>' +
    '<span class="feedback-star" data-value="3">⭐</span>' +
    '<span class="feedback-star" data-value="4">⭐</span>' +
    '<span class="feedback-star" data-value="5">⭐</span>' +
    '</div>' +
    '<textarea class="feedback-textarea" id="feedback-text-input" placeholder="Anything specific? (optional)" maxlength="500"></textarea>' +
    '<div class="feedback-modal-actions">' +
    '<button class="feedback-btn-submit" onclick="submitFeedback()">Send Feedback</button>' +
    '<button class="feedback-btn-skip" onclick="closeFeedbackModal()">Skip</button>' +
    '</div></div>' +
    '<div id="feedback-thankyou" class="feedback-thankyou" style="display:none;">' +
    '<span class="feedback-thankyou-emoji">🙏</span>' +
    '<div class="feedback-thankyou-text">Thank you for your feedback!</div>' +
    '<div class="feedback-thankyou-sub">It means a lot. See you soon.</div>' +
    '</div></div>';

  document.body.appendChild(overlay);

  var stars = overlay.querySelectorAll('.feedback-star');
  stars.forEach(function(star) {
    star.addEventListener('click', function() {
      FEEDBACK.selectedStar = parseInt(star.getAttribute('data-value'));
      stars.forEach(function(s, i) {
        s.classList.toggle('selected', i < FEEDBACK.selectedStar);
      });
    });
    star.addEventListener('mouseenter', function() {
      var val = parseInt(star.getAttribute('data-value'));
      stars.forEach(function(s, i) { s.style.opacity = i < val ? '1' : '0.4'; });
    });
  });
  overlay.querySelector('.feedback-stars').addEventListener('mouseleave', function() {
    stars.forEach(function(s, i) { s.style.opacity = i < FEEDBACK.selectedStar ? '1' : '0.4'; });
  });
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeFeedbackModal();
  });
}

function showFeedbackModal() {
  if (FEEDBACK.shown) return;
  // Reset star each time so it feels fresh
  FEEDBACK.selectedStar = 0;
  buildFeedbackModal();
  FEEDBACK.shown = true;
  requestAnimationFrame(function() {
    var overlay = document.getElementById('feedback-modal-overlay');
    if (overlay) overlay.classList.add('visible');
  });
}

function closeFeedbackModal() {
  var overlay = document.getElementById('feedback-modal-overlay');
  if (!overlay) return;
  overlay.classList.remove('visible');
  setTimeout(function() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 300);
  // Allow modal to show again next session
  FEEDBACK.shown = false;
}

function submitFeedback() {
  var rating = FEEDBACK.selectedStar;
  var text   = (document.getElementById('feedback-text-input') || {}).value || '';
  var form   = document.getElementById('feedback-form-content');
  var thanks = document.getElementById('feedback-thankyou');
  if (form)   form.style.display   = 'none';
  if (thanks) thanks.style.display = 'block';

  var entry = {
    rating:    rating,
    text:      text.trim(),
    timestamp: new Date().toISOString(),
    session:   Math.round((performance.now() - (STATE.sessionStart || 0)) / 1000) + 's',
  };
  try {
    var existing = JSON.parse(localStorage.getItem('aria-feedback') || '[]');
    existing.push(entry);
    if (existing.length > 20) existing = existing.slice(-20);
    localStorage.setItem('aria-feedback', JSON.stringify(existing));
  } catch(e) {}

  // Always send to server — even text-only feedback (no star) is useful
  if (CHAT.serverOnline) {
    fetch(CHAT.SERVER_URL + '/feedback', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(entry),
    }).catch(function(){});
  }
  setTimeout(closeFeedbackModal, 2200);
}

window.addEventListener('beforeunload', function() {
  if (!FEEDBACK.shown) {
    var sessionMs = STATE.sessionStart ? performance.now() - STATE.sessionStart : 0;
    if (sessionMs >= FEEDBACK.minSessionMs) {
      try { localStorage.setItem('aria-session-end', new Date().toISOString()); } catch(e){}
    }
  }
});

// ── SERVICE WORKER ─────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/sw.js')
      .then(function(reg) {
        console.log('[PWA] Service worker registered:', reg.scope);

        // ── FIX: Listen for waiting SW and activate immediately ──
        // This stops the Android "old model" warning loop
        reg.addEventListener('updatefound', function() {
          var newWorker = reg.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', function() {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                // New SW is waiting — activate it immediately
                newWorker.postMessage({ type: 'SKIP_WAITING' });
              }
            });
          }
        });
      })
      .catch(function(err) {
        console.log('[PWA] Service worker not available:', err.message);
      });

    // Reload page when new SW takes over (seamless update)
    var refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', function() {
      if (!refreshing) {
        refreshing = true;
        window.location.reload();
      }
    });
  });
}


// ═══════════════════════════════════════════════════════════════
// PWA INSTALL
// ═══════════════════════════════════════════════════════════════
var deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', function(e) {
  e.preventDefault();
  deferredInstallPrompt = e;
  showInstallCard('android');
});

function triggerInstall() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  deferredInstallPrompt.userChoice.then(function(choice) {
    if (choice.outcome === 'accepted') {
      dismissInstall();
      console.log('[PWA] Installed successfully');
    }
    deferredInstallPrompt = null;
  });
}

function dismissInstall() {
  var card = document.getElementById('install-card');
  if (card) card.style.display = 'none';
  sessionStorage.setItem('install-dismissed', '1');
}

function showInstallCard(platform) {
  if (sessionStorage.getItem('install-dismissed')) return;
  if (window.navigator.standalone === true) return;
  var card     = document.getElementById('install-card');
  var btnMain  = document.getElementById('install-btn-main');
  var iosSteps = document.getElementById('install-ios-steps');
  if (!card) return;
  card.style.display = 'block';

  if (platform === 'ios') {
    // ── FIX: force style override for iOS inline style conflict ──
    if (iosSteps) { iosSteps.style.cssText = 'display:flex !important; flex-direction:column;'; }
    if (btnMain)  { btnMain.style.cssText  = 'display:none !important;'; }
  } else {
    if (btnMain)  { btnMain.style.cssText  = 'display:flex !important;'; }
    if (iosSteps) { iosSteps.style.cssText = 'display:none !important;'; }
  }
}

// iOS Safari detection
(function() {
  var isIOS       = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  var isSafari    = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  var isStandalone = window.navigator.standalone === true;
  if (isIOS && isSafari && !isStandalone) {
    setTimeout(function() { showInstallCard('ios'); }, 4000);
  }
})();

window.addEventListener('appinstalled', function() {
  dismissInstall();
  console.log('[PWA] App installed');
});