// ═══════════════════════════════════════════════════════════════
// FACE AI TRACKER — app.js
// Phase 3: Emotion Detection + All Phase 2 Metrics
//
// WHAT IS NEW IN PHASE 3:
// ─ face-api.js emotion model (7 emotions, pretrained neural net)
// ─ Real-time emotion bars: Happy, Neutral, Sad, Angry,
//   Surprised, Fearful, Disgusted
// ─ Primary emotion display with emoji + confidence %
// ─ Emotion smoothing — prevents bar flickering every frame
// ─ Emotion integrated into feedback messages
//
// HOW EMOTION DETECTION WORKS:
// face-api.js includes a tiny CNN (Convolutional Neural Network)
// trained on the AffectNet dataset (~450k labelled face images).
// It takes a face crop from the video, runs it through the network,
// and outputs 7 probability scores that sum to 1.0.
// We display these as percentage bars and pick the highest as the
// current emotion.
//
// ARCHITECTURE:
// ┌─────────────────────────────────────────────────────┐
// │  Webcam frame                                       │
// │     ↓                                               │
// │  MediaPipe FaceMesh → 468 landmarks + blink/pose   │
// │     ↓                                               │
// │  face-api.js expressionNet → 7 emotion scores      │
// │     ↓                                               │
// │  Combined metrics → Focus score + Feedback          │
// └─────────────────────────────────────────────────────┘
// ═══════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────
// 1. CONFIG
// ─────────────────────────────────────────────────────────────
var CONFIG = {
  // Drawing
  DOT_RADIUS:        1.8,
  DOT_COLOR:         '#00e5ff',
  EYE_DOT_COLOR:     '#ff3366',
  EYE_DOT_RADIUS:    3.5,
  BOX_COLOR:         'rgba(0,229,255,0.35)',
  FPS_INTERVAL:      500,

  // Blink detection
  BLINK_DROP:        0.055,  // EAR must drop this far below baseline
  EAR_FLOOR:         0.10,
  EAR_FALLBACK:      0.13,
  BLINK_FRAMES:      3,

  // Calibration
  CALIB_DURATION_MS: 4000,

  // Head pose thresholds (degrees)
  TILT_THRESHOLD:    15,
  NOD_THRESHOLD:     12,

  // Focus score weights
  W_EAR:             0.35,
  W_BLINK:           0.25,
  W_HEAD:            0.25,
  W_EMOTION:         0.15,  // emotion now contributes to focus score

  NORMAL_BPM:        16,
  SMOOTH:            0.88,

  // Emotion detection
  // Run emotion detection every N frames
  EMOTION_EVERY_N_FRAMES: 3,

  // Smoothing factor for emotion bars
  // Higher = smoother but slower to respond
  EMOTION_SMOOTH: 0.80,

  // Minimum confidence to display an emotion
  EMOTION_MIN_CONFIDENCE: 0.05,

  // Temporal voting window — how many readings to average
  // before committing to an emotion. Higher = more stable.
  // 8 readings at every-3-frames = ~0.8 seconds of data
  EMOTION_VOTE_WINDOW: 8,

  // Minimum vote share (0-1) to confirm an emotion change
  // 0.45 = emotion must win 45% of recent frames
  EMOTION_VOTE_THRESHOLD: 0.45,
};


// ─────────────────────────────────────────────────────────────
// 2. LANDMARK INDICES
// ─────────────────────────────────────────────────────────────
var LM = {
  RIGHT_EYE: [33,  160, 158, 133, 153, 144],
  LEFT_EYE:  [263, 387, 385, 362, 380, 373],
  NOSE_TIP:     1,
  NOSE_BRIDGE:  168,
  LEFT_TEMPLE:  234,
  RIGHT_TEMPLE: 454,
  CHIN:         152,
  FOREHEAD:     10,
};

// Emotion display config — emoji and CSS class for each emotion
var EMOTION_CONFIG = {
  happy:     { emoji: '😊', label: 'Happy',     cssClass: 'bar-happy'     },
  neutral:   { emoji: '😐', label: 'Neutral',   cssClass: 'bar-neutral'   },
  sad:       { emoji: '😔', label: 'Sad',       cssClass: 'bar-sad'       },
  angry:     { emoji: '😠', label: 'Angry',     cssClass: 'bar-angry'     },
  surprised: { emoji: '😲', label: 'Surprised', cssClass: 'bar-surprised' },
  fearful:   { emoji: '😨', label: 'Fearful',   cssClass: 'bar-fearful'   },
  disgusted: { emoji: '🤢', label: 'Disgusted', cssClass: 'bar-disgusted' },
};


// ─────────────────────────────────────────────────────────────
// 3. STATE
// ─────────────────────────────────────────────────────────────
var STATE = {
  // Models
  meshModel:        null,   // MediaPipe face mesh
  emotionModelReady:false,  // face-api.js emotion model loaded?
  isRunning:        false,
  animFrameId:      null,
  lastFrameTime:    0,
  frameCount:       0,

  // Calibration
  calibrating:      false,
  calibDone:        false,
  calibSamples:     [],
  calibStartTime:   0,
  earBaseline:      0.19,
  earThreshold:     CONFIG.EAR_FALLBACK,

  // Blink state machine
  blinkState:       'OPEN',
  blinkFrameCount:  0,
  blinkTotal:       0,
  sessionStart:     0,

  // Emotion state
  framesSinceEmotion: 0,
  smoothedEmotions: {
    happy:     0, neutral:  0.5, sad:      0,
    angry:     0, surprised:0,   fearful:  0, disgusted: 0,
  },
  currentEmotion:    'neutral',
  emotionConfidence: 0,
  // Temporal voting — stores last N raw emotion readings
  // before committing to a displayed emotion
  emotionVoteHistory: [],  // array of strings e.g. ['neutral','neutral','angry']
  confirmedEmotion:   'neutral',  // only changes after vote threshold is met

  // Smoothed values
  smoothFocus:      50,
  lastEAR:          0.19,

  // Head pose (saved every frame for AI chat access)
  headTiltAngle:    0,
  headNodAngle:     0,

  // Canvas scaling — ratio of pixel size to CSS display size
  // Used to position landmark dots correctly on mobile
  scaleX: 1,
  scaleY: 1,
};


// ─────────────────────────────────────────────────────────────
// 4. DOM REFERENCES
// ─────────────────────────────────────────────────────────────
var DOM = {
  video:          document.getElementById('webcam'),
  canvas:         document.getElementById('overlay-canvas'),
  startBtn:       document.getElementById('start-btn'),
  statusDot:      document.getElementById('status-dot'),
  statusText:     document.getElementById('status-text'),
  faceDetected:   document.getElementById('face-detected'),
  landmarkCount:  document.getElementById('landmark-count'),
  fpsValue:       document.getElementById('fps-value'),
  tfStatus:       document.getElementById('tf-status'),
  modelStatus:    document.getElementById('model-status'),
  emotionModelStatus: document.getElementById('emotion-model-status'),
  earValue:       document.getElementById('ear-value'),
  blinkCount:     document.getElementById('blink-count'),
  blinkRate:      document.getElementById('blink-rate'),
  headTilt:       document.getElementById('head-tilt'),
  headNod:        document.getElementById('head-nod'),
  focusScore:     document.getElementById('focus-score'),
  focusBar:       document.getElementById('focus-bar'),
  feedbackText:   document.getElementById('feedback-text'),
  calibStatus:    document.getElementById('calib-status'),
  // Emotion panel elements
  emotionEmoji:   document.getElementById('emotion-emoji'),
  emotionName:    document.getElementById('emotion-name'),
  emotionConf:    document.getElementById('emotion-confidence'),
  emotionStatus:  document.getElementById('emotion-status'),
};

var CTX = DOM.canvas.getContext('2d');


// ─────────────────────────────────────────────────────────────
// 5. MATH HELPERS
// ─────────────────────────────────────────────────────────────

function dist(a, b) {
  var dx = b.x - a.x, dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
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

function lerp(cur, tgt, f) { return cur * f + tgt * (1 - f); }
function clamp(v, lo, hi)  { return Math.min(Math.max(v, lo), hi); }

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce(function(s, v) { return s + v; }, 0) / arr.length;
}

function topPercent(arr, pct) {
  if (!arr.length) return arr;
  var sorted = arr.slice().sort(function(a, b) { return a - b; });
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
    if (bar)   bar.style.width = Math.round(progress * 100) + '%';
    if (label) label.textContent = 'Calibrating... ' + Math.round(progress * 100) + '%';
  }

  if (ear > 0.10) STATE.calibSamples.push(ear);

  if (elapsed >= CONFIG.CALIB_DURATION_MS) {
    STATE.calibrating = false;
    STATE.calibDone   = true;

    if (STATE.calibSamples.length >= 3) {
      var topSamples     = topPercent(STATE.calibSamples, 0.60);
      STATE.earBaseline  = avg(topSamples);
      STATE.earThreshold = Math.max(STATE.earBaseline - CONFIG.BLINK_DROP, CONFIG.EAR_FLOOR);
      console.log('[Calibration ✓] Samples:', STATE.calibSamples.length,
        '| Baseline:', STATE.earBaseline.toFixed(4),
        '| Threshold:', STATE.earThreshold.toFixed(4));
    } else if (STATE.calibSamples.length > 0) {
      STATE.earBaseline  = avg(STATE.calibSamples);
      STATE.earThreshold = Math.max(STATE.earBaseline - CONFIG.BLINK_DROP, CONFIG.EAR_FLOOR);
      console.warn('[Calibration ~] Partial. Baseline:', STATE.earBaseline.toFixed(4));
    } else {
      var bestGuess      = STATE.lastEAR > 0.12 ? STATE.lastEAR : 0.19;
      STATE.earBaseline  = bestGuess;
      STATE.earThreshold = Math.max(bestGuess - CONFIG.BLINK_DROP, CONFIG.EAR_FALLBACK);
      console.warn('[Calibration ✗] No samples. Estimated:', bestGuess.toFixed(4));
    }

    if (DOM.calibStatus) DOM.calibStatus.style.display = 'none';
    setStatus('Detection running — look at the camera!', 'running');
  }
}


// ─────────────────────────────────────────────────────────────
// 7. EMOTION DETECTION
//
// face-api.js expressionNet takes a HTMLVideoElement and returns
// an array of detections. Each detection has an .expressions
// object with probabilities for all 7 emotions.
//
// We run this every N frames (not every frame) because it is
// slightly heavier than landmark detection. N=3 at 30fps =
// smooth 10 updates per second, which looks great.
//
// We smooth the emotion bars with lerp() so they glide
// instead of jumping between frames.
// ─────────────────────────────────────────────────────────────

async function detectEmotions() {
  if (!STATE.emotionModelReady) return null;

  // Guard: video must be playing with real pixels
  if (DOM.video.readyState < 2 || DOM.video.videoWidth === 0) return null;

  try {
    // faceapi.detectSingleFace() feeds the video element into the
    // tinyFaceDetector CNN to find a face, then withFaceExpressions()
    // pipes the face crop into the expressionNet for 7 emotion scores.
    //
    // inputSize: 224 — input resolution. Higher = more accurate but slower.
    //   224 is the sweet spot for real-time use.
    // scoreThreshold: 0.3 — minimum face detection confidence.
    //   Lower than 0.3 causes false positives on non-face regions.
    var result = await faceapi
      .detectSingleFace(
        DOM.video,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.3 })
      )
      .withFaceExpressions();

    if (!result || !result.expressions) return null;

    // result.expressions is an object like:
    // { happy: 0.92, neutral: 0.05, sad: 0.01, angry: 0.01,
    //   surprised: 0.0, fearful: 0.0, disgusted: 0.01 }
    // Values always sum to ~1.0 (softmax output)
    return result.expressions;

  } catch (err) {
    // Silent fail — one bad frame does not stop the loop
    return null;
  }
}

/**
 * smoothEmotions(newExpressions)
 *
 * TWO-LAYER ACCURACY SYSTEM:
 *
 * Layer 1 — Bar smoothing (lerp):
 *   Each emotion bar value is gently smoothed so the bars
 *   glide instead of jumping every frame. This is purely visual.
 *
 * Layer 2 — Temporal voting:
 *   The DISPLAYED emotion (big emoji + name) only changes
 *   after it wins the majority of the last N readings.
 *   This prevents false positives like "Disgusted" showing
 *   for 1-2 frames just because the model briefly misread
 *   a neutral expression. An emotion must be consistent
 *   across ~0.8 seconds before it is announced.
 *
 * WHY THIS MATTERS:
 *   The TinyFaceDetector was trained on a dataset with
 *   limited diversity. It sometimes reads neutral/serious
 *   dark-skinned faces as "angry" or "disgusted" for a
 *   few frames. Temporal voting filters those spikes out.
 */
function smoothEmotions(newExpressions) {
  if (!newExpressions) return;

  // ── Layer 1: Smooth the bar values visually ─────────────
  var keys = Object.keys(STATE.smoothedEmotions);
  for (var i = 0; i < keys.length; i++) {
    var key    = keys[i];
    var newVal = newExpressions[key] || 0;
    STATE.smoothedEmotions[key] = lerp(
      STATE.smoothedEmotions[key],
      newVal,
      1 - CONFIG.EMOTION_SMOOTH
    );
  }

  // ── Layer 2: Temporal voting for displayed emotion ──────

  // Find the raw winner of this single frame
  var frameWinner = 'neutral';
  var frameMax    = 0;
  for (var k in newExpressions) {
    if (newExpressions[k] > frameMax) {
      frameMax    = newExpressions[k];
      frameWinner = k;
    }
  }

  // Only add to vote history if confidence is meaningful
  // (above 30% prevents low-confidence noise polluting the vote)
  if (frameMax > 0.30) {
    STATE.emotionVoteHistory.push(frameWinner);
  } else {
    // Low confidence frame — push 'neutral' as a stabiliser
    STATE.emotionVoteHistory.push('neutral');
  }

  // Keep window size
  if (STATE.emotionVoteHistory.length > CONFIG.EMOTION_VOTE_WINDOW) {
    STATE.emotionVoteHistory.shift();
  }

  // Count votes in the window
  var votes = {};
  for (var j = 0; j < STATE.emotionVoteHistory.length; j++) {
    var e = STATE.emotionVoteHistory[j];
    votes[e] = (votes[e] || 0) + 1;
  }

  // Find the emotion with the most votes
  var voteWinner = 'neutral';
  var voteMax    = 0;
  for (var ek in votes) {
    if (votes[ek] > voteMax) {
      voteMax    = votes[ek];
      voteWinner = ek;
    }
  }

  // Only confirm the emotion if it clears the threshold
  var voteShare = voteMax / STATE.emotionVoteHistory.length;
  if (voteShare >= CONFIG.EMOTION_VOTE_THRESHOLD) {
    STATE.confirmedEmotion = voteWinner;
  }
  // If nothing clears threshold, keep the previous confirmed emotion

  // Use confirmed emotion for display and feedback
  STATE.currentEmotion    = STATE.confirmedEmotion;
  STATE.emotionConfidence = STATE.smoothedEmotions[STATE.currentEmotion] || 0;
}

/**
 * emotionToFocusScore(emotion, confidence)
 * Converts current emotion into a focus component (0-100).
 *
 * Emotions associated with engagement/focus → higher score
 * Emotions associated with disengagement → lower score
 */
function emotionToFocusComponent(emotion, confidence) {
  var scores = {
    neutral:   80,  // neutral = attentive baseline
    happy:     85,  // happy = engaged
    surprised: 70,  // surprised = alert but distracted
    sad:       35,  // sad = disengaged
    angry:     30,  // angry = stressed
    fearful:   30,  // fearful = stressed
    disgusted: 25,  // disgusted = very disengaged
  };
  var base = scores[emotion] || 50;
  // Weight by confidence — low confidence emotion means less signal
  return clamp(base * confidence + 50 * (1 - confidence), 0, 100);
}


// ─────────────────────────────────────────────────────────────
// 8. METRICS ENGINE
// ─────────────────────────────────────────────────────────────

function computeMetrics(keypoints) {
  var now = performance.now();

  // EAR
  var rPts = getKPGroup(keypoints, LM.RIGHT_EYE);
  var lPts = getKPGroup(keypoints, LM.LEFT_EYE);
  var earR = rPts ? calcEAR(rPts) : STATE.lastEAR;
  var earL = lPts ? calcEAR(lPts) : STATE.lastEAR;
  var ear  = (earR + earL) / 2;
  STATE.lastEAR = ear;

  // Calibration phase
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

  // Blink state machine
  var thr = STATE.earThreshold;
  if (ear < thr) {
    STATE.blinkFrameCount++;
    if (STATE.blinkState === 'OPEN') STATE.blinkState = 'CLOSING';
    if (STATE.blinkState === 'CLOSING' && STATE.blinkFrameCount >= CONFIG.BLINK_FRAMES) {
      STATE.blinkState = 'CLOSED';
    }
  } else {
    if (STATE.blinkState === 'CLOSED') STATE.blinkTotal++;
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

  // Save to STATE so collectFaceData() can read them for AI chat
  STATE.headTiltAngle = tiltAngle;
  STATE.headNodAngle  = nodAngle;

  // Focus score — now includes emotion component
  var earRange  = STATE.earBaseline - thr;
  var earScore  = earRange > 0.001
    ? clamp((ear - thr) / earRange * 100, 0, 100)
    : clamp((ear - 0.10) / 0.15 * 100, 0, 100);

  var blinkScore = bpm === 0 ? 70 :
    bpm >= 8 && bpm <= 25 ? clamp(100 - Math.abs(bpm - CONFIG.NORMAL_BPM) * 3, 50, 100) :
    bpm > 25 ? clamp(100 - (bpm - 25) * 4, 0, 50) :
    clamp(bpm * 8, 0, 50);

  var tiltPen    = clamp(Math.abs(tiltAngle) / CONFIG.TILT_THRESHOLD * 40, 0, 40);
  var nodPen     = clamp(Math.abs(nodAngle)  / CONFIG.NOD_THRESHOLD  * 40, 0, 40);
  var headScore  = clamp(100 - tiltPen - nodPen, 0, 100);

  var emotionScore = emotionToFocusComponent(STATE.currentEmotion, STATE.emotionConfidence);

  var rawFocus = earScore   * CONFIG.W_EAR   +
                 blinkScore * CONFIG.W_BLINK +
                 headScore  * CONFIG.W_HEAD  +
                 emotionScore * CONFIG.W_EMOTION;

  STATE.smoothFocus = lerp(STATE.smoothFocus, rawFocus, CONFIG.SMOOTH);

  return {
    ear:         Math.round(ear * 1000) / 1000,
    earOpen:     ear >= thr,
    blinks:      STATE.blinkTotal,
    bpm:         bpm,
    bpmReady:    elapsedMs > 15000,
    tiltAngle:   Math.round(tiltAngle * 10) / 10,
    nodAngle:    Math.round(nodAngle  * 10) / 10,
    focusScore:  Math.round(STATE.smoothFocus),
    feedback:    makeFeedback(ear, bpm, tiltAngle, nodAngle,
                   STATE.smoothFocus, elapsedMs, thr,
                   STATE.currentEmotion, STATE.emotionConfidence),
    calibrating: false,
  };
}


// ─────────────────────────────────────────────────────────────
// 9. SMART FEEDBACK — now includes emotion context
// ─────────────────────────────────────────────────────────────

function makeFeedback(ear, bpm, tilt, nod, focus, elapsed, thr, emotion, conf) {
  if (elapsed < 5000) return '⏳ Warming up — hold still...';

  // Emotion-specific messages (high confidence only)
  if (conf > 0.6) {
    if (emotion === 'happy')     return '😊 You look happy and engaged — great energy!';
    if (emotion === 'angry')     return '😠 You look tense or frustrated. Take a breath.';
    if (emotion === 'sad')       return '😔 You seem a bit down. Is everything okay?';
    if (emotion === 'fearful')   return '😨 You look anxious. Try to relax your face.';
    if (emotion === 'disgusted') return '🤢 Something bothering you? Try to refocus.';
    if (emotion === 'surprised') return '😲 Surprised! Something caught your attention.';
  }

  // Physical state messages
  if (ear < thr * 0.65)       return '😴 Eyes nearly closed — are you falling asleep?';
  if (bpm > 35)                return '😰 Very high blink rate (' + bpm + '/min) — stress or fatigue.';
  if (Math.abs(nod) > 20)      return '😪 Head drooping — drowsiness detected.';
  if (ear < thr && bpm > 22)   return '🥱 Heavy eyes + frequent blinking — take a break soon.';
  if (Math.abs(tilt) > CONFIG.TILT_THRESHOLD)
    return '↗ Head tilted ' + (tilt > 0 ? 'right' : 'left') + ' — try sitting upright.';
  if (bpm > 22)                return '😓 Blink rate above normal (' + bpm + '/min) — early fatigue.';
  if (bpm > 0 && bpm < 5)      return '👁 Very low blink rate — eyes may be strained.';

  // Focus level messages
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
    // Step 1 — Initialise TensorFlow.js with WebGL backend.
    // This must happen BEFORE face-api does anything with tf.
    await tf.setBackend('webgl');
    await tf.ready();
    updateEl('tf-status', 'Ready ✓ (WebGL)');

    // Step 2 — Load emotion model weights.
    //
    // WHY @vladmandic/face-api:
    // The original face-api.js@0.22.2 bundles its own TF.js internally.
    // Loading it alongside our TF.js 3.21.0 causes both to fight over
    // the WebGL backend registration → "d is not a function" crash.
    //
    // @vladmandic/face-api is the maintained fork that skips bundling
    // TF.js and uses whatever tf object it finds on the page — no conflict.
    //
    // The model weights (tinyFaceDetector + faceExpressionNet) are small
    // JSON + binary shard files hosted on the same CDN package.
    // loadFromUri fetches them automatically by appending the model name.

    updateEl('emotion-model-status', 'Loading...');
    setStatus('Loading emotion model (~2MB)...', 'waiting');

    var MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model';

    // tinyFaceDetector: lightweight face finder (~190KB)
    // faceExpressionNet: 7-class emotion CNN (~310KB)
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    await faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL);

    STATE.emotionModelReady = true;
    updateEl('emotion-model-status', 'Loaded ✓');
    if (DOM.emotionStatus) DOM.emotionStatus.textContent = 'Ready — start detection';
    console.log('[face-api] Emotion models loaded successfully');

    // Step 3 — Load MediaPipe face mesh model.
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

    updateEl('model-status', 'Loaded ✓');
    setStatus('All models ready — click Start Detection!', 'waiting');
    DOM.startBtn.disabled    = false;
    DOM.startBtn.textContent = 'Start Detection';
    return true;

  } catch (err) {
    setStatus('Model load error: ' + err.message, 'error');
    console.error('Model load failed:', err);
    // Even if emotion model fails, try to enable at least face mesh
    if (STATE.meshModel) {
      DOM.startBtn.disabled    = false;
      DOM.startBtn.textContent = 'Start (no emotion)';
    }
    return false;
  }
}

async function startCamera() {
  setStatus('Requesting camera permission...', 'waiting');
  try {
    // Detect if on mobile — request portrait dimensions for better face framing
    var isMobile = window.innerWidth <= 480 ||
                   /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

    var videoConstraints = isMobile
      ? {
          // Portrait mode on mobile — taller than wide so face fills frame
          width:      { ideal: 480 },
          height:     { ideal: 640 },
          facingMode: 'user',
        }
      : {
          // Landscape on desktop
          width:      { ideal: 640 },
          height:     { ideal: 480 },
          facingMode: 'user',
        };

    var stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: false,
    });

    DOM.video.srcObject = stream;
    await new Promise(function(r) { DOM.video.addEventListener('loadedmetadata', r, { once: true }); });
    await new Promise(function(r) { DOM.video.addEventListener('canplay',        r, { once: true }); });

    // Set canvas to exact video pixel dimensions
    DOM.canvas.width  = DOM.video.videoWidth;
    DOM.canvas.height = DOM.video.videoHeight;

    console.log('[Camera] Resolution:', DOM.video.videoWidth, 'x', DOM.video.videoHeight,
                '| Mobile:', isMobile);
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

    // Calculate scale ratio between canvas pixel size and CSS display size.
    // On mobile the canvas may be 480px wide in pixels but 320px wide on screen.
    // Keypoints come back in pixel space so we scale them to display space
    // when drawing so dots land exactly on the face as seen on screen.
    var displayW = DOM.canvas.offsetWidth  || DOM.canvas.width;
    var displayH = DOM.canvas.offsetHeight || DOM.canvas.height;
    STATE.scaleX = DOM.canvas.width  / displayW;
    STATE.scaleY = DOM.canvas.height / displayH;

    // ── Face mesh detection (every frame) ──────────────────
    var faces = await STATE.meshModel.estimateFaces(DOM.video, { flipHorizontal: false });
    CTX.clearRect(0, 0, DOM.canvas.width, DOM.canvas.height);

    if (faces && faces.length > 0 &&
        faces[0].keypoints && faces[0].keypoints.length > 0) {

      var pts = faces[0].keypoints;
      drawAllDots(pts);
      drawEyeDots(pts);
      drawBox(faces[0].box);

      var m = computeMetrics(pts);
      updatePanel(true, pts.length);
      updateMetrics(m);

    } else {
      updatePanel(false, 0);
      if (!STATE.calibrating && DOM.feedbackText) {
        DOM.feedbackText.textContent = '👤 No face detected — move closer to the camera.';
      }
    }

    // ── Emotion detection (every N frames) ─────────────────
    // We run this separately from mesh detection because it
    // operates on the raw video, not on landmarks.
    STATE.framesSinceEmotion++;
    if (STATE.framesSinceEmotion >= CONFIG.EMOTION_EVERY_N_FRAMES &&
        !STATE.calibrating && STATE.emotionModelReady) {
      STATE.framesSinceEmotion = 0;
      var expressions = await detectEmotions();
      if (expressions) {
        smoothEmotions(expressions);
        updateEmotionPanel();
      }
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
// 12. DRAWING
// ─────────────────────────────────────────────────────────────

function drawAllDots(kpts) {
  CTX.save();
  CTX.fillStyle = CONFIG.DOT_COLOR;
  for (var i = 0; i < kpts.length; i++) {
    CTX.beginPath();
    CTX.arc(kpts[i].x, kpts[i].y, CONFIG.DOT_RADIUS, 0, Math.PI * 2);
    CTX.fill();
  }
  CTX.restore();
}

function drawEyeDots(kpts) {
  var idx = LM.RIGHT_EYE.concat(LM.LEFT_EYE);
  CTX.save();
  CTX.fillStyle = CONFIG.EYE_DOT_COLOR;
  for (var i = 0; i < idx.length; i++) {
    var p = kpts[idx[i]];
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
  CTX.lineWidth   = 2;
  CTX.strokeRect(x - 12, y - 12, w + 24, h + 24);
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
    if (fd) { fd.textContent = 'Yes ✓'; fd.className = 'stat-value val-good'; }
    if (lc) lc.textContent = count;
  } else {
    if (fd) { fd.textContent = 'No';    fd.className = 'stat-value val-bad'; }
    if (lc) lc.textContent = '0';
  }
}

// Session timer — updates every second while running
var timerInterval = null;

function startSessionTimer() {
  var timerEl  = document.getElementById('timer-value');
  var timerWrap = document.getElementById('session-timer');
  var liveEl   = document.getElementById('live-dot');
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

// Update the animated focus ring SVG
function updateFocusRing(score) {
  var ring = document.getElementById('focus-ring-fill');
  var num  = document.getElementById('focus-score');
  var badge = document.getElementById('focus-score-badge');
  if (!ring) return;

  var circumference = 2 * Math.PI * 50; // r=50 → ~314
  var offset = circumference - (score / 100) * circumference;
  ring.style.strokeDashoffset = offset;

  // Colour the ring based on score
  if (score >= 70) {
    ring.style.stroke = '#00e5ff';
  } else if (score >= 40) {
    ring.style.stroke = '#ffd740';
  } else {
    ring.style.stroke = '#ff5252';
  }

  if (num)   num.textContent   = score;
  if (badge) badge.textContent = score + ' / 100';
}

function updateMetrics(m) {
  // EAR — metric tile
  var earTile = document.getElementById('ear-value');
  if (earTile) {
    earTile.textContent = m.calibrating ? 'calibrating' : m.ear.toFixed(3);
    earTile.className   = 'metric-tile-value ' + (m.earOpen ? 'val-accent' : 'val-warn');
  }

  // Blink count
  var bc = document.getElementById('blink-count');
  if (bc) bc.textContent = m.blinks;

  // Blink rate tile
  var br = document.getElementById('blink-rate');
  if (br) {
    br.textContent = m.calibrating ? '—' : !m.bpmReady ? '...' : m.bpm;
    br.className   = 'metric-tile-value ' + (m.bpm > 25 || (m.bpm > 0 && m.bpm < 5) ? 'val-warn' : 'val-accent');
  }

  // Head tilt tile
  var ht = document.getElementById('head-tilt');
  if (ht) {
    var ta = Math.abs(m.tiltAngle);
    ht.textContent = ta < 3 ? 'Level' : (m.tiltAngle > 0 ? '→ ' : '← ') + ta.toFixed(1) + '°';
    ht.className   = 'metric-tile-value ' + (ta > CONFIG.TILT_THRESHOLD ? 'val-warn' : 'val-good');
  }

  // Head nod tile
  var hn = document.getElementById('head-nod');
  if (hn) {
    var na = Math.abs(m.nodAngle);
    hn.textContent = na < 5 ? 'Level' : (m.nodAngle > 0 ? '↓ ' : '↑ ') + na.toFixed(1) + '°';
    hn.className   = 'metric-tile-value ' + (na > CONFIG.NOD_THRESHOLD ? 'val-warn' : 'val-good');
  }

  // Focus ring
  updateFocusRing(m.focusScore);

  // Video overlay stats
  var vosEar    = document.getElementById('vos-ear');
  var vosFocus  = document.getElementById('vos-focus');
  var vosBlinks = document.getElementById('vos-blinks');
  if (vosEar)    vosEar.textContent    = m.ear.toFixed(3);
  if (vosFocus)  vosFocus.textContent  = m.focusScore;
  if (vosBlinks) vosBlinks.textContent = m.blinks;

  // Feedback banner
  var fb = document.getElementById('feedback-text');
  if (fb) fb.textContent = m.feedback;
}

/**
 * updateEmotionPanel()
 * Updates all 7 emotion bars and the primary emotion display.
 * Called after every emotion detection run.
 */
function updateEmotionPanel() {
  var emotions = STATE.smoothedEmotions;
  var current  = STATE.currentEmotion;
  var conf     = STATE.emotionConfidence;
  var cfg      = EMOTION_CONFIG[current] || { emoji: '😐', label: current };

  // Primary emotion display
  if (DOM.emotionEmoji) DOM.emotionEmoji.textContent = cfg.emoji;
  if (DOM.emotionName)  DOM.emotionName.textContent  = cfg.label;
  if (DOM.emotionConf)  DOM.emotionConf.textContent  = Math.round(conf * 100) + '% confidence';
  if (DOM.emotionStatus) DOM.emotionStatus.textContent = '';

  // Update each emotion bar
  var keys = ['happy', 'neutral', 'sad', 'angry', 'surprised', 'fearful', 'disgusted'];
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var val = emotions[key] || 0;
    var pct = Math.round(val * 100);

    var bar     = document.getElementById('bar-' + key);
    var pctEl   = document.getElementById('pct-' + key);

    if (bar)   bar.style.width     = pct + '%';
    if (pctEl) pctEl.textContent   = pct + '%';

    // Highlight the dominant emotion bar
    if (bar) {
      bar.style.opacity = (key === current && conf > CONFIG.EMOTION_MIN_CONFIDENCE) ? '1' : '0.5';
    }
  }
}


// ─────────────────────────────────────────────────────────────
// 14. ENTRY POINT
// ─────────────────────────────────────────────────────────────

async function init() {
  console.log('Face AI Tracker — Phase 4 initialising...');
  DOM.startBtn.disabled    = true;
  DOM.startBtn.textContent = 'Loading models...';
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

      // Full state reset
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
      CHAT.history             = [];
      CHAT.rateLimitedUntil    = 0;
      CHAT.consecutiveErrors   = 0;
      var ekeys = Object.keys(STATE.smoothedEmotions);
      for (var i = 0; i < ekeys.length; i++) STATE.smoothedEmotions[ekeys[i]] = 0;
      STATE.smoothedEmotions.neutral = 0.5;
      STATE.emotionVoteHistory = [];
      STATE.confirmedEmotion   = 'neutral';

      startCalibration();
      startSessionTimer();
      startAutoAnalysis();

      // Show video overlay stats strip
      var vos = document.getElementById('video-overlay-stats');
      if (vos) vos.style.display = 'flex';

      // Style the button as Stop
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
        DOM.video.srcObject.getTracks().forEach(function(t) { t.stop(); });
        DOM.video.srcObject = null;
      }
      if (DOM.calibStatus) DOM.calibStatus.style.display = 'none';

      // Hide video overlay
      var vos = document.getElementById('video-overlay-stats');
      if (vos) vos.style.display = 'none';

      CTX.clearRect(0, 0, DOM.canvas.width, DOM.canvas.height);
      setStatus('Stopped. Click Start to run again.', 'waiting');

      // Reset button style
      DOM.startBtn.textContent = 'Start Detection';
      DOM.startBtn.className   = 'btn-primary';
      DOM.startBtn.disabled    = false;

      updatePanel(false, 0);
      updateFocusRing(0);
      if (DOM.fpsValue) DOM.fpsValue.textContent = '—';
    }
  });
}


// ═══════════════════════════════════════════════════════════════
// PHASE 5 — AI CHAT SYSTEM
//
// HOW IT WORKS:
// 1. Every 15 seconds (when running), collectFaceData() packages
//    all current metrics and sends them to the Node.js server
// 2. The server calls Claude and returns a natural language response
// 3. The response appears as a chat bubble in the chat panel
// 4. The user can also type their own questions manually
// 5. All conversation history is kept so Claude has context
// ═══════════════════════════════════════════════════════════════

var CHAT = {
  SERVER_URL:       ':https://face-ai-tracker-production.up.railway.app',
  AUTO_INTERVAL_MS: 45000,   // auto-analyze every 45 seconds
                             // Gemini free tier: 15 req/min, 1500/day
                             // 45s = max ~80 requests/hour — safe and generous
  serverOnline:     false,
  autoTimer:        null,
  history:          [],      // conversation history for AI context
  isWaiting:        false,   // true while waiting for a response
  rateLimitedUntil: 0,       // timestamp — pause requests until this time
  consecutiveErrors:0,       // track errors to back off automatically
};

// ── SERVER HEALTH CHECK ─────────────────────────────────────

async function checkServer() {
  try {
    var res = await fetch(CHAT.SERVER_URL + '/health', {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      CHAT.serverOnline = true;
      updateServerStatus(true);
      return true;
    }
  } catch (e) {
    // Server not running
  }
  CHAT.serverOnline = false;
  updateServerStatus(false);
  return false;
}

function updateServerStatus(online) {
  var dot  = document.getElementById('chat-server-dot');
  var text = document.getElementById('chat-status-text');
  var srv  = document.getElementById('server-status');

  if (dot)  dot.className  = 'chat-server-dot ' + (online ? 'dot-online' : 'dot-offline');
  if (text) text.textContent = online ? 'Server connected' : 'Server offline — run: node server.js';
  if (srv)  {
    srv.textContent = online ? 'Connected ✓' : 'Offline';
    srv.className   = 'stat-value ' + (online ? 'val-good' : 'val-bad');
  }
}

// ── COLLECT CURRENT FACE DATA ───────────────────────────────

function collectFaceData() {
  // Use only post-calibration time for BPM accuracy
  // (calibration takes 4s — blinks during it are not counted anyway)
  var now        = performance.now();
  var elapsed    = now - STATE.sessionStart;
  var elapsedMin = elapsed / 60000;
  var bpm        = (elapsed > 15000 && elapsedMin > 0)
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

// ── AUTO ANALYSIS ───────────────────────────────────────────

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
  if (CHAT.autoTimer) {
    clearInterval(CHAT.autoTimer);
    CHAT.autoTimer = null;
  }
}

// ═══════════════════════════════════════════════════════════════
// AI BRAIN — Local Intelligence Engine
// Runs 100% in browser. Gemini enhances when available.
// ═══════════════════════════════════════════════════════════════

var AI = {
  observationCount: 0,
  lastEmotionSeen:  null,
  proactiveAlerts:  { drowsy: false, session30: false, session50: false },

  observe: function(d) {
    var emotion = d.emotion || 'neutral';
    var focus   = d.focusScore || 0;
    var bpm     = d.blinkRate  || 0;
    var ear     = d.ear        || 0;
    var tilt    = Math.abs(d.headTilt || 0);
    var nod     = Math.abs(d.headNod  || 0);
    var mins    = Math.round((d.sessionMs || 0) / 60000);
    var conf    = d.emotionConfidence || 0;
    var thr     = STATE.earThreshold || 0.15;

    if (ear < thr * 0.65 || nod > 22) {
      return '😴 You look like you might be falling asleep. Try standing up, doing 10 jumping jacks, or splashing cold water on your face to reset your alertness.';
    }
    if (bpm > 32) {
      return "😰 I'm noticing a high blink rate — your eyes are telling me they're tired or stressed. Close your eyes fully for 10 seconds, then look at something distant.";
    }
    if (emotion === 'angry' && conf > 0.5) {
      return "😤 You're showing signs of frustration. Step away for 2 minutes, breathe in for 4 counts and out for 6. You'll come back with a clearer perspective.";
    }
    if (emotion === 'sad' && conf > 0.5) {
      return "😔 Something seems to be weighing on you. A 5-minute walk outside genuinely helps — natural light and movement shift emotional states faster than anything else.";
    }
    if (emotion === 'fearful' && conf > 0.5) {
      return "😨 You look a bit anxious or tense. Unclench your jaw, drop your shoulders, and take one slow breath. Tension in the face reflects tension in the mind.";
    }
    if (emotion === 'happy' && conf > 0.6 && focus >= 70) {
      return '😊🎯 This is your peak state — happy and highly focused at ' + focus + '/100. Use this moment for your hardest task. You have been at it ' + mins + ' min — stay in the flow.';
    }
    if (focus >= 80) {
      var msgs = [
        '🎯 You are in deep focus at ' + focus + '/100. Eyes open, posture good, expression calm. This is optimal — stay here.',
        '⚡ Strong focus — ' + focus + '/100. At ' + mins + ' minutes in, you are clearly in your element. Protect this time.',
        '✅ Everything looks great — focus ' + focus + '/100, blink rate healthy, posture level. You are performing well.',
      ];
      return msgs[AI.observationCount % msgs.length];
    }
    if (focus >= 60) {
      if (mins >= 20 && mins < 35) {
        return '🕐 ' + mins + ' minutes in with solid focus at ' + focus + '/100. The Pomodoro method suggests a 5-minute break at 25 minutes — you decide if you are in a flow state worth protecting.';
      }
      return '✅ Good focus at ' + focus + '/100 with blink rate ' + (bpm > 0 ? bpm + '/min — ' + (bpm <= 20 ? 'healthy.' : 'a little elevated.') : 'steady.');
    }
    if (focus < 40) {
      return '⚠️ Focus has dipped to ' + focus + '/100. A 5-minute complete break — no screen, no phone — often recovers more than an hour of struggling through. Try it.';
    }
    if (mins >= 50) {
      return '⏰ Nearly an hour in. Cognitive performance measurably drops after 45-60 minutes. A 10-minute break now will make your next session sharper, not weaker.';
    }
    if (tilt > 12) {
      return '↗ Your head is tilted ' + Math.round(tilt) + '° — this often happens when distracted. Sit upright with your screen at eye level. Posture directly affects alertness.';
    }
    return '🙂 Looking calm and present. Focus is ' + focus + '/100. ' + (bpm > 0 ? 'Blink rate ' + bpm + '/min — ' + (bpm <= 20 ? 'healthy.' : 'a little elevated.') : 'Keep going.');
  },

  answer: function(question, d) {
    var q       = question.toLowerCase().trim();
    var emotion = d.emotion || 'neutral';
    var focus   = d.focusScore || 0;
    var bpm     = d.blinkRate  || 0;
    var ear     = d.ear        || 0;
    var mins    = Math.round((d.sessionMs || 0) / 60000);
    var conf    = d.emotionConfidence || 0;
    var thr     = STATE.earThreshold || 0.15;

    if (q.match(/what can i do|what should i do|help me|prescri|suggest|advice|recommend|improve|better/)) {
      if (ear < thr * 0.7 || bpm > 28) {
        return '🛠 Action plan for right now:\n\n1. 👁 Close your eyes completely for 10 seconds\n2. 🚶 Stand up and walk for 2 minutes\n3. 💧 Drink a glass of water\n4. 🌬 3 deep breaths: inhale 4 counts, hold 4, exhale 6\n\nCome back in 5 minutes and your numbers will be better.';
      }
      if (emotion === 'angry' || emotion === 'fearful') {
        return '🛠 For stress and tension right now:\n\n1. 🌬 4-7-8 breathing: inhale 4, hold 7, exhale 8\n2. 💪 Clench fists tight for 5 seconds, then fully release\n3. 📝 Write down the one thing bothering you\n4. 🎵 Play one song you love before continuing\n\nStress is energy — redirect it.';
      }
      if (emotion === 'sad') {
        return '🛠 For low mood right now:\n\n1. ☀️ Get near natural light for 5 minutes\n2. 🏃 20 jumping jacks — fastest natural mood booster\n3. 📞 Send a positive message to someone you like\n4. 🎯 Pick ONE very small task and complete it\n\nYou do not have to feel good to start. You start to feel good.';
      }
      if (focus < 45) {
        return '🛠 To recover your focus right now:\n\n1. 📵 Phone face down out of reach\n2. 🎧 Instrumental music or white noise\n3. 📝 Write your single next action in one sentence\n4. ⏱ Set a 25-minute timer\n5. 💧 Drink water — dehydration reduces cognition 10-15%\n\nFocus is a muscle. These are the reps.';
      }
      return '🛠 You are doing well at ' + focus + '/100. To stay here:\n\n1. 🔒 Protect your environment — no new tabs\n2. ⏱ Work in 25-minute blocks with 5-minute breaks\n3. 👁 20-20-20 rule: every 20 min, look 20 feet away for 20 seconds\n4. 💧 Keep water nearby\n\nYou are already in a good state. Keep going.';
    }

    if (q.match(/feel better|feel good|cheer|happy|mood|energy|motivat/)) {
      return '😊 To shift your energy:\n\n1. 🏃 Move your body 2 minutes — movement changes chemistry\n2. ☀️ Natural light on your face — even 3 minutes outside helps\n3. 🎵 Play a song that makes you feel powerful\n4. 🙏 Name 3 things you have done well today\n5. 📞 Send a positive message to someone\n\nYour emotion reads ' + emotion + ' right now. In 5 minutes it can be different.';
    }

    if (q.match(/tired|fatigue|sleepy|exhausted|drowsy|heavy|eyes hurt|eye strain/)) {
      return '😴 Fastest fatigue recovery:\n\n1. 👁 Palming — cup warm hands over closed eyes for 30 seconds\n2. 💧 Cold water on wrists and face\n3. 🌬 5 deep breaths, exhale twice as long as inhale\n4. 🚶 5 minutes outside — natural light resets alertness\n5. 😮 Yawn deliberately 3 times\n\nYour EAR is ' + ear.toFixed(3) + ' — ' + (ear < thr * 0.8 ? 'your eyes are showing real strain.' : 'eyes are holding up okay.');
    }

    if (q.match(/focus|concentrat|distract|attention|productiv/)) {
      return '🎯 Focus score: ' + focus + '/100 — ' + (focus >= 75 ? 'excellent.' : focus >= 50 ? 'moderate.' : 'below your best.') + '\n\nWhat actually works:\n1. 📝 Write your next single action down\n2. 🎧 Binaural beats at 40Hz (search YouTube)\n3. ⏱ 25 min work, 5 min break\n4. 🌡 Cooler room (18-20°C) keeps the brain alert\n5. 📵 Airplane mode — each notification costs 23 minutes of focus';
    }

    if (q.match(/stress|anxious|anxiety|overwhelm|pressure|worry|nervous/)) {
      return '🌬 For stress right now:\n\nImmediate (30 seconds):\n• Box breathing: in 4, hold 4, out 4, hold 4. Do this twice.\n\nShort term (5 minutes):\n• Brain dump — write everything on your mind on paper\n• Circle the ONE most important thing\n• Everything else can wait\n\nPosture:\n• Uncross legs, drop shoulders, unclench jaw\n\nStress is energy — give it a clear target.';
    }

    if (q.match(/break|rest|pause/)) {
      return '⏰ After ' + mins + ' minute' + (mins !== 1 ? 's' : '') + ', ' + (mins >= 25 ? 'yes — your brain genuinely needs it.' : 'even a short break helps.') + '\n\nFor maximum recovery:\n1. 🚶 5 minutes walking beats sitting on your phone\n2. 👀 Look at something natural — trees, sky\n3. 🍵 Drink something warm\n4. 🧘 Do nothing deliberately for 2 minutes\n\nBreaks are not lost time. They are when the work gets processed.';
    }

    if (q.match(/emotion|feel|feeling|how am i|how do i look|mood|expression/)) {
      var ed = { happy: 'engaged and positive — best state for creative work', neutral: 'calm and composed — ideal for analytical tasks', sad: 'a little low — gentle tasks or a short break might help', angry: 'tense or frustrated — energy that needs redirecting', surprised: 'alert and engaged', fearful: 'anxious or under pressure — breathing exercises will help', disgusted: 'uncomfortable with something' };
      return '📊 Right now you appear ' + emotion + ' (' + Math.round(conf * 100) + '% confidence).\n\nIn practical terms: ' + (ed[emotion] || 'in a neutral state') + '.\n\nFocus: ' + focus + '/100, blinks: ' + (bpm > 0 ? bpm + '/min (' + (bpm <= 20 ? 'healthy' : 'elevated') + ').' : 'measuring...') + '\n\nAsk "what can I do now" for specific actions.';
    }

    if (q.match(/eye|blink|ear|vision|screen/)) {
      return '👁 Your eye metrics:\n• Openness (EAR): ' + ear.toFixed(3) + ' — ' + (ear >= thr ? 'eyes open and alert' : 'eyes partially closed') + '\n• Blink rate: ' + (bpm > 0 ? bpm + '/min (normal: 12-20)' : 'measuring...') + '\n\nFor eye health:\n1. 20-20-20 rule: every 20 min, look 20 feet away for 20 seconds\n2. Screen brightness should match room lighting\n3. Blink deliberately — screens reduce blink rate by up to 60%';
    }

    if (q.match(/how long|session|time|duration|minutes/)) {
      return '⏱ Session: ' + mins + ' minute' + (mins !== 1 ? 's' : '') + '\n\n• Total blinks: ' + d.blinkCount + '\n• Focus: ' + focus + '/100\n• Emotion: ' + emotion + '\n\n' + (mins < 25 ? '✅ Good time to keep going.' : mins < 50 ? '⏰ Consider a break at 50 minutes.' : '🔴 Past the point of diminishing returns — take a real break.');
    }


    if (q.match(/what is|how does|who are you|explain/)) {
      return '🤖 I am the AI built into Face AI Tracker.\n\nWhat I watch:\n• Emotion — 7 types via neural network\n• Eye openness (EAR) — fatigue indicator\n• Blink rate — stress and tiredness signal\n• Head position — posture and drowsiness\n• Focus score — combined 0-100 metric\n\nTry asking:\n"What can I do to feel better?"\n"How is my focus?"\n"I feel stressed — help me"\n"Should I take a break?"';
    }

    // ── GREETINGS ───────────────────────────────────────────
    if (q.match(/^(hi|hello|hey|good morning|good afternoon|good evening|what.s up|sup)/)) {
      return 'Hello! 👋 I can see you right now — currently reading you as ' + emotion + ' with focus at ' + focus + '/100. How can I help you today?';
    }

    // ── THANKS ──────────────────────────────────────────────
    if (q.match(/thank|thanks|appreciate|helpful/)) {
      return "You're welcome! 😊 I'm here whenever you need me. I'm watching your face in real time — just ask whenever you want to know how you're doing.";
    }

    // ── WHAT CAN YOU DO ─────────────────────────────────────
    if (q.match(/what can you do|capabilities|features|what do you know|what do you see/)) {
      return '🤖 Here is what I can help with:\n\n👁 Your state right now — emotion, focus, fatigue, posture\n🛠 Prescriptions — exact steps to improve how you feel\n😴 Fatigue detection — I will warn you before you burn out\n🎯 Focus coaching — science-backed techniques\n💆 Stress relief — breathing, movement, mindset\n⏰ Break reminders — based on how long you have been working\n\nJust talk to me naturally. Ask anything.';
    }

    // ── MOTIVATION ──────────────────────────────────────────
    if (q.match(/motivat|inspire|encour|i can.t|i give up|i quit|i.m done|push me/)) {
      return '💪 You showed up. You are here, the camera is on, and you are still going.\n\nFocus is ' + focus + '/100. That is real.\n\nThe people who succeed are not the ones who feel motivated — they are the ones who act first and let the feeling follow.\n\nPick one thing. Do just that one thing. You got this.';
    }

    // ── MENTAL HEALTH ────────────────────────────────────────
    if (q.match(/depress|lonely|hopeless|worthless|suicid|harm|crisis/)) {
      return '💙 I hear you, and that matters.\n\nI am an AI and I cannot provide mental health support, but a real person can.\n\nPlease reach out:\n• Crisis text line: text HOME to 741741 (free, 24/7)\n• International: findahelpline.com\n• Talk to someone you trust\n\nYou do not have to handle this alone.';
    }

    // ── MEDICAL ─────────────────────────────────────────────
    if (q.match(/sick|pain|headache|doctor|diagnos|symptom|medic/)) {
      return '🏥 I can see your facial state but I cannot diagnose health conditions.\n\nFor medical questions please consult a doctor.\n\nWhat I can help with: focus, eye fatigue, stress levels, and mental performance during work.';
    }

    // ── FUNNY / OFF-TOPIC ────────────────────────────────────
    if (q.match(/joke|funny|laugh|lol|haha|meme|bored/)) {
      return '😄 Why did the computer go to therapy?\n— Because it had too many *tabs* open and could not focus.\n\nSpeaking of which — your focus is ' + focus + '/100. Want tips to improve it?';
    }

    if (q.match(/weather|news|sports|music|food|recipe/)) {
      return '😄 Ha — I only know about one thing: you and your face.\n\nYour emotion: ' + emotion + '. Focus: ' + focus + '/100. Blink rate: ' + (bpm > 0 ? bpm + '/min' : 'measuring') + '.\n\nFor everything else, Google is your friend!';
    }

    if (q.match(/who made|who built|who created|your developer/)) {
      return '🧑‍💻 Face AI Tracker was built with JavaScript, TensorFlow.js, MediaPipe face mesh, and Google Gemini AI.\n\nIt uses real computer vision, neural networks, and the Eye Aspect Ratio formula from academic research. Pretty powerful for a browser app.';
    }

    if (q.match(/are you real|are you human|are you ai|chatgpt|claude|gpt/)) {
      return '🤖 I am a purpose-built AI — not ChatGPT. I was designed specifically for one job: understanding your face and helping you perform better.\n\nRight now I can see: ' + emotion + ' (' + Math.round(conf * 100) + '% confidence), focus ' + focus + '/100.';
    }

    if (q.match(/test|testing|is this working|can you hear|hello world/)) {
      return '✅ Yes, working! Live data:\n• Emotion: ' + emotion + ' (' + Math.round(conf * 100) + '%)\n• Focus: ' + focus + '/100\n• EAR: ' + ear.toFixed(3) + '\n• Blinks: ' + (bpm > 0 ? bpm + '/min' : 'measuring') + '\n• Session: ' + mins + ' min\n\nEverything is running. Ask me anything!';
    }

    if (q.match(/meaning of life|philosophy|god|religion|politics|future|robot/)) {
      return '🌍 Big question! I respect it.\n\nI was built to watch faces and help people perform better, not solve the universe. What I can tell you: you are here, you are working, and your brain is capable of more than it gets credit for.\n\nYour focus is ' + focus + '/100. Want to make it higher?';
    }

    // ── ULTIMATE FALLBACK ────────────────────────────────────
    return "I'm not sure I fully understood that, but here's what I'm seeing right now:\n\nYou appear " + emotion + " with " + Math.round(conf * 100) + "% confidence. Focus is " + focus + "/100.\n\nIf you want specific help, try asking:\n• \"What can I do to feel better?\"\n• \"How is my focus?\"\n• \"I feel stressed\"\n• \"Should I take a break?\"";
  },
};

// ── CHAT ENGINE ──────────────────────────────────────────────

async function runAnalysis() {
  if (CHAT.isWaiting) return;
  CHAT.isWaiting = true;
  showTypingIndicator();
  var faceData = collectFaceData();
  var response = null;

  if (CHAT.serverOnline && CHAT.rateLimitedUntil <= performance.now()) {
    try {
      var res = await fetch(CHAT.SERVER_URL + '/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emotion: faceData.emotion, emotionConfidence: faceData.emotionConfidence,
          focusScore: faceData.focusScore, blinkRate: faceData.blinkRate,
          blinkCount: faceData.blinkCount, ear: faceData.ear,
          headTilt: faceData.headTilt, headNod: faceData.headNod, sessionMs: faceData.sessionMs,
        }),
        signal: AbortSignal.timeout(12000),
      });
      var data = await res.json();
      if (res.ok && !data.error) {
        response = data.response;
        updateChatStatusText('AI ready');
      } else if (res.status === 429) {
        CHAT.rateLimitedUntil = performance.now() + 3600000;
        updateChatStatusText('AI ready');
      }
    } catch (e) { /* silent fallback */ }
  }

  if (!response) { response = AI.observe(faceData); AI.observationCount++; }
  removeTypingIndicator();
  addChatMessage('ai', response);
  CHAT.history.push({ role: 'assistant', content: response });
  if (CHAT.history.length > 10) CHAT.history.shift();
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
  addChatMessage('user', text);

  CHAT.isWaiting = true;
  showTypingIndicator();
  var faceData = collectFaceData();
  var response = null;

  if (CHAT.serverOnline && CHAT.rateLimitedUntil <= performance.now()) {
    try {
      var res = await fetch(CHAT.SERVER_URL + '/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, faceData: faceData, history: CHAT.history.slice(-6) }),
        signal: AbortSignal.timeout(15000),
      });
      var data = await res.json();
      if (res.ok && !data.error) { response = data.response; }
      else if (res.status === 429) { CHAT.rateLimitedUntil = performance.now() + 3600000; }
    } catch (e) { /* silent fallback */ }
  }

  if (!response) { response = AI.answer(text, faceData); }
  removeTypingIndicator();
  addChatMessage('ai', response);
  CHAT.history.push({ role: 'user', content: text });
  CHAT.history.push({ role: 'assistant', content: response });
  if (CHAT.history.length > 14) CHAT.history.splice(0, 2);
  CHAT.isWaiting = false;
}

// Enter key to send
document.addEventListener('DOMContentLoaded', function() {
  var input = document.getElementById('chat-input');
  if (input) {
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
      }
    });
  }
});

// ── CHAT UI HELPERS ─────────────────────────────────────────

function addChatMessage(role, text) {
  var container = document.getElementById('chat-messages');
  if (!container) return;

  var div = document.createElement('div');
  div.className = 'chat-msg chat-msg--' + role;

  var now = new Date();
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
  container.scrollTop = container.scrollHeight;
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

// ── START CHAT WHEN DETECTION STARTS ───────────────────────

var originalDetectionLoop = detectionLoop;

// Check server on load
setTimeout(checkServer, 1000);
// Re-check every 30 seconds
setInterval(checkServer, 30000);

init();

// ── SERVICE WORKER REGISTRATION ─────────────────────────────
// Registers the PWA service worker which enables:
// - Offline use after first visit
// - Fast loading from cache
// - "Install app" prompt on mobile and desktop
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/sw.js')
      .then(function(reg) {
        console.log('[PWA] Service worker registered:', reg.scope);
      })
      .catch(function(err) {
        // Service worker failed — app still works, just no offline support
        console.log('[PWA] Service worker not available (normal on file://)');
      });
  });
}

// ── PWA INSTALL PROMPT ───────────────────────────────────────
// Catches the browser's "install app" prompt and shows it
// as a button in our UI so users know they can install
var deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', function(e) {
  e.preventDefault();
  deferredInstallPrompt = e;
  showInstallButton();
});

function showInstallButton() {
  // Add an install button to the nav bar if not already there
  var nav = document.querySelector('.topnav-actions');
  if (!nav || document.getElementById('install-btn')) return;

  var btn = document.createElement('button');
  btn.id        = 'install-btn';
  btn.className = 'btn-install';
  btn.innerHTML = '📲 Install App';
  btn.onclick   = function() {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then(function(result) {
      if (result.outcome === 'accepted') {
        console.log('[PWA] User installed the app');
        btn.remove();
      }
      deferredInstallPrompt = null;
    });
  };

  // Insert before the Start button
  nav.insertBefore(btn, nav.firstChild);
}

// ── iOS INSTALL BANNER ───────────────────────────────────────
// iOS Safari does not support the beforeinstallprompt event.
// Instead we show a manual instruction banner telling users
// to use Share → Add to Home Screen.
// Only show on iOS Safari when NOT already installed as PWA.

(function() {
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  var isInStandaloneMode = window.navigator.standalone === true;
  var isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

  // Show banner if: on iOS, in Safari browser (not already installed)
  if (isIOS && isSafari && !isInStandaloneMode) {
    // Only show once per session
    var shown = sessionStorage.getItem('ios-install-shown');
    if (!shown) {
      setTimeout(function() {
        var banner = document.getElementById('ios-install-card');
        if (banner) {
          banner.style.display = 'block';
          sessionStorage.setItem('ios-install-shown', '1');
        }
      }, 3000); // Show after 3 seconds so it does not interrupt loading
    }
  }
})();