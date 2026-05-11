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
    // We use the same resolution on all devices.
    // The video fills the wrapper using object-fit: contain (no cropping),
    // which means MediaPipe keypoint coordinates map exactly to
    // what the user sees — no offset or scaling issues.
    var stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width:      { ideal: 640 },
        height:     { ideal: 480 },
        facingMode: 'user',
      },
      audio: false,
    });

    DOM.video.srcObject = stream;
    await new Promise(function(r) { DOM.video.addEventListener('loadedmetadata', r, { once: true }); });
    await new Promise(function(r) { DOM.video.addEventListener('canplay', r, { once: true }); });

    // Set canvas to exact video pixel dimensions
    DOM.canvas.width  = DOM.video.videoWidth;
    DOM.canvas.height = DOM.video.videoHeight;

    console.log('[Camera]', DOM.video.videoWidth, 'x', DOM.video.videoHeight);
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
  SERVER_URL:       'https://face-ai-tracker-production.up.railway.app',
  AUTO_INTERVAL_MS: 45000,   // auto-analyze every 45 seconds
                             // Gemini free tier: 15 req/min, 1500/day
                             // 45s = max ~80 requests/hour — safe and generous
  serverOnline:     false,
  autoTimer:        null,
  history:          [],      // conversation history for AI context
  isWaiting:        false,   // true while waiting for a response
  rateLimitedUntil: 0,
  lastUserMessageTime: 0,
  consecutiveErrors: 0,
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

// ═══════════════════════════════════════════════════════════════
// ARIA — Local Wellness Coach (offline fallback)
// When Gemini is available it handles everything.
// When offline this local engine provides genuine wellness support.
// It understands complex human situations, not just face data.
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// ARIA — AI Wellness Coach (Local Intelligence Engine)
//
// This runs entirely in the browser with no server needed.
// When Gemini is connected, it uses that for deeper responses.
// When offline, Aria handles everything locally with genuine depth.
//
// Aria is not just a pattern matcher. She understands context,
// asks follow-up questions, and goes deep on any wellness topic.
// ═══════════════════════════════════════════════════════════════

var AI = {
  observationCount:  0,
  lastEmotionSeen:   null,
  conversationDepth: 0, // tracks how deep the conversation has gone
  lastTopic:         null, // remembers what was discussed

  // ── PROACTIVE OBSERVATION (auto every 45s) ────────────────
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

    // Critical states first
    if (ear < thr * 0.65 || nod > 22) {
      return "I can see your eyes are very heavy and your head is drooping. Your body is telling you something important right now — you need rest. Can you take even 5 minutes to close your eyes?";
    }
    if (bpm > 32) {
      return "I'm noticing your blink rate is quite high — " + bpm + " times per minute. That's a sign your eyes and nervous system are under strain. Take a slow breath with me. In through the nose for 4 counts... hold... out for 6.";
    }
    if (emotion === 'angry' && conf > 0.5) {
      return "I can see tension in your expression right now. Something is frustrating you — and that's completely valid. Before you continue, try this: unclench your jaw, roll your shoulders back, and take one deep breath. What's on your mind?";
    }
    if (emotion === 'sad' && conf > 0.5) {
      return "I notice you look a little low right now. Sometimes our face shows what our words don't. I'm here if you want to talk — there's no pressure. How are you really doing?";
    }
    if (emotion === 'fearful' && conf > 0.5) {
      return "Your expression is showing some anxiety or worry. That feeling is real and it matters. Try grounding yourself: name 5 things you can see right now. It sounds simple, but it works. Want to talk about what's weighing on you?";
    }
    if (emotion === 'happy' && conf > 0.6 && focus >= 70) {
      return "You look genuinely happy and focused right now — " + focus + "/100. This is your peak state. Whatever you're working on, this is the time to push forward. You've been at it " + mins + " minutes — keep that energy going.";
    }
    if (focus >= 80) {
      var msgs = [
        "You're in deep focus — " + focus + "/100. Eyes open, posture steady, expression calm. This is optimal performance. Protect this state.",
        "Strong focus at " + focus + "/100. " + mins + " minutes in and you're clearly in your element. This kind of consistency is rare.",
        "Everything looks excellent — focus " + focus + "/100. Your mind is sharp right now. Stay here as long as you can.",
      ];
      return msgs[AI.observationCount % 3];
    }
    if (focus >= 60) {
      if (mins >= 20 && mins < 35) {
        return "You've been working " + mins + " minutes with solid focus at " + focus + "/100. You might be approaching your first natural break point soon — but if you're in flow, stay with it. Your body will tell you when to stop.";
      }
      return "Good focus at " + focus + "/100" + (bpm > 0 ? " with a blink rate of " + bpm + "/min — " + (bpm <= 20 ? "healthy and relaxed." : "slightly elevated, watch for fatigue.") : ".") + " You're doing well.";
    }
    if (focus < 40) {
      return "Your focus has dipped to " + focus + "/100. This happens — it doesn't mean you've failed. Sometimes the best thing is a complete 5-minute break: no screen, no phone, just fresh air or water. Want some specific techniques to reset?";
    }
    if (mins >= 50) {
      return "You've been working for nearly an hour. Research consistently shows cognitive performance drops after 45-60 minutes. A 10-minute real break now will make the next hour sharper. How are you feeling?";
    }
    if (tilt > 12) {
      return "I notice your head is tilted " + Math.round(tilt) + "° — this often happens unconsciously when we're uncertain or distracted. Try sitting upright, screen at eye level. Your posture directly affects your mental clarity.";
    }

    AI.observationCount++;
    return "You look calm and present. Focus at " + focus + "/100" + (bpm > 0 ? ", blink rate " + bpm + "/min" : "") + ". " + (mins > 0 ? mins + " minutes in — keep going." : "Getting started — you've got this.");
  },

  // ── DEEP CONVERSATIONAL WELLNESS COACHING ────────────────
  answer: function(question, d) {
    var q       = question.toLowerCase().trim();
    var emotion = d.emotion    || 'neutral';
    var focus   = d.focusScore || 0;
    var bpm     = d.blinkRate  || 0;
    var ear     = d.ear        || 0;
    var mins    = Math.round((d.sessionMs || 0) / 60000);
    var conf    = d.emotionConfidence || 0;
    var thr     = STATE.earThreshold || 0.15;
    AI.conversationDepth++;

    // ── GREETINGS ────────────────────────────────────────────
    if (q.match(/^(hi|hello|hey|good morning|good evening|good afternoon|howdy|what'?s up|sup)\b/)) {
      var greets = [
        "Hello! I'm Aria, your wellness coach. I can see you right now — you're looking " + emotion + " with focus at " + focus + "/100. How are you feeling today? What's on your mind?",
        "Hey there! Good to see you. Your face is showing " + emotion + " energy right now. How are you really doing — what brings you here today?",
        "Hi! I'm here for you. I can see from your expression that you're " + emotion + " right now. Is there something specific you wanted to talk about, or shall I just check in on how you're doing?",
      ];
      return greets[AI.conversationDepth % 3];
    }

    // ── FEELING BAD / NOT GOOD TODAY ─────────────────────────
    if (q.match(/don'?t feel (good|well|great|okay|fine)|not feeling|feel (bad|terrible|awful|horrible|low|down|off|weird)|feeling (bad|terrible|low|down|off|rough|shit|crap)/)) {
      AI.lastTopic = 'feeling-bad';
      return "I hear you — and I'm glad you said something. 💙\n\nLooking at your face right now, I can see " + (conf > 0.4 ? "you appear " + emotion + ", " : "") + "and that matches what you're describing.\n\nCan you tell me a bit more about what's going on? Is it more of a physical thing — like tired, drained, body feels heavy? Or is it more emotional — like something is weighing on your mind or heart? The more you share, the better I can actually help you.";
    }

    // ── PERSONAL STRUGGLES / LIFE ISSUES ────────────────────
    if (q.match(/marital|marriage|husband|wife|partner|relationship|divorce|breakup|break.?up|couple/)) {
      AI.lastTopic = 'relationship';
      return "That sounds really painful, and I want you to know — what you're carrying is heavy. Relationship stress is one of the most draining things a person can go through because it affects every single part of your life.\n\nFirst, I want to acknowledge: you showing up here today, even while going through this, shows real strength.\n\nCan I ask — what feels most overwhelming about it right now? Is it the conflict itself, the uncertainty about the future, the exhaustion of it all, or something else? I want to understand where you are before I say anything else.";
    }

    if (q.match(/family|parent|child|children|kid|son|daughter|brother|sister|sibling/)) {
      AI.lastTopic = 'family';
      return "Family stress cuts deep — these are the people closest to us, which means the pain can be the most complicated kind.\n\nI'm listening. What's going on with your family situation? Tell me what's been happening, and let's work through it together.";
    }

    if (q.match(/work|job|boss|colleague|career|fired|laid.?off|overwork|deadline|office/)) {
      AI.lastTopic = 'work';
      return "Work stress is real and it has a way of following you home and into every quiet moment.\n\nI can see from your face you're carrying something — " + (focus < 50 ? "your focus score is " + focus + "/100 which suggests your mind is divided right now." : "though your focus is holding at " + focus + "/100.") + "\n\nWhat's happening at work? Tell me what's been going on — I want the full picture, not just the surface.";
    }

    if (q.match(/exhaust|burnout|burn.?out|drained|depleted|no energy|tired of everything|can'?t anymore|too much|overwhelm/)) {
      AI.lastTopic = 'burnout';
      return "Exhaustion at this level — the kind where everything feels like too much — is your mind and body sending a serious signal. This isn't weakness. This is your system saying it has been running on empty for too long.\n\nI want to help you, but first I need to understand: how long have you been feeling this way? Is this recent, or has it been building for a while? And is there one main thing draining you, or is it everything at once?";
    }

    if (q.match(/paranoi|paranoid|anxious|anxiety|panic|fear|scared|afraid|nervous|worry|worried|overthink/)) {
      AI.lastTopic = 'anxiety';
      return "What you're describing — that paranoid, anxious, hypervigilant feeling — is genuinely exhausting. When the mind is constantly scanning for threat, even rest doesn't feel like rest.\n\nI want you to know: this is a real experience, not something you're imagining or making up.\n\nRight now, let's do one thing together. Look around the room and name 5 things you can physically see. Go ahead — I'll wait. This isn't a trick; it's called grounding, and it works by anchoring your nervous system to the present moment.\n\nAfter you do that, tell me — how long have you been feeling this way?";
    }

    if (q.match(/depress|depressed|hopeless|empty|numb|worthless|don'?t care|nothing matters|point(less)?|meaningless/)) {
      AI.lastTopic = 'depression';
      return "Thank you for trusting me with this. What you're describing sounds really painful — that heavy, hopeless, empty feeling is one of the hardest things to carry.\n\nI want to be honest with you: I'm an AI, and what you're feeling may need more support than I alone can give. A real therapist or counsellor can help in ways I can't.\n\nBut I also don't want to just send you away — I'm here with you right now. Can you tell me more about when this started? Has something changed recently, or has it been a slow build over time?";
    }

    if (q.match(/lonely|alone|isolated|no one|nobody|no friends|no support/)) {
      AI.lastTopic = 'loneliness';
      return "Loneliness is one of the most painful human experiences — and it's more common than people admit, which somehow makes it lonelier.\n\nI see you. You reached out, and that matters.\n\nCan I ask — is this a new feeling, or has it been there for a while? And is it more about not having people around, or having people around but still feeling unseen and unheard?";
    }

    if (q.match(/life (is|going|falling|has been)|my life|going through|struggling|hard time|difficult|tough time|can'?t cope|falling apart/)) {
      AI.lastTopic = 'life-challenge';
      return "When life feels like it's going sideways, everything becomes harder — even the small things. The weight of it adds up.\n\nI can see from your expression that you're carrying something real right now. I'm not going to give you a list of tips — that's not what this moment needs.\n\nTell me what's actually going on. What does \"things are hard\" look like for you right now? The more real you can be with me, the more I can actually help.";
    }

    if (q.match(/suicid|kill myself|end it|don'?t want to (be here|live|exist)|want to die/)) {
      AI.lastTopic = 'crisis';
      return "I hear you, and I want you to know that what you're feeling right now matters deeply.\n\nPlease reach out to someone who can really be there for you right now:\n\n🆘 Crisis Text Line: Text HOME to 741741 (free, 24/7)\n📞 International resources: findahelpline.com\n\nI'm an AI and I want to be honest — you deserve real human support for this. Please don't face this alone. Is there someone near you right now — a friend, family member, anyone — who you could call or be with?";
    }

    // ── FOLLOW-UP / DEEPER QUESTIONS ────────────────────────
    if (q.match(/what (should|can|do) i do|how (do|can) i|help me|advice|suggest|what next/)) {
      if (AI.lastTopic === 'relationship') {
        return "For relationship pain specifically — here's what I'd suggest working through:\n\n1. 🧠 Separate what you can control from what you can't. You cannot control the other person — only your responses.\n\n2. 💬 Find a safe space to express what you're feeling — a trusted friend, journal, or therapist. Keeping it all inside amplifies it.\n\n3. 🛑 Set a boundary with your own rumination: give yourself 20 minutes to think about it, then redirect. Your mind needs rest from it too.\n\n4. 💆 Take care of your body — sleep, eat, move. Emotional pain depletes physical resources faster than you realise.\n\nWhat feels most difficult to act on right now?";
      }
      if (AI.lastTopic === 'burnout') {
        return "For genuine burnout — and I want to be clear this is different from just being tired — the recovery is slower than people expect:\n\n1. ⏸ The first thing is permission. You have to give yourself permission to not be at full capacity right now. Fighting burnout with more effort makes it worse.\n\n2. 🔍 Identify your biggest energy drains. Not everything — just the top 1-2 things taking the most from you.\n\n3. 🛑 Protect one small thing that restores you, every day. Even 15 minutes. Sleep. Nature. Quiet.\n\n4. 🗣 Talk to someone — whether that's a manager, doctor, friend, or therapist. Burnout that's named can be addressed.\n\nHow long do you realistically think you can keep going at your current pace?";
      }
      if (AI.lastTopic === 'anxiety') {
        return "For anxiety and paranoid thinking — there are things that genuinely help:\n\n1. 🌬 Breathwork: 4-7-8 breathing (in 4, hold 7, out 8) activates your parasympathetic nervous system — the calm-down switch.\n\n2. 📝 Externalise the worry: write down exactly what you're afraid of. The act of writing removes it from the loop in your head.\n\n3. 🏃 Physical movement: even a 10-minute walk burns off the stress hormones that fuel anxiety.\n\n4. 🔍 Reality-check: ask yourself \"what is the evidence this will actually happen?\" Anxiety lies.\n\nIs the anxiety connected to something specific, or is it more free-floating — like a general sense of dread?";
      }
      // Generic action advice
      return "Based on what you've shared with me, here's where I'd start:\n\nFirst — acknowledge that what you're going through is real and it makes sense that it's affecting you. You're not weak for struggling.\n\nSecond — pick just ONE small action today. Not a list, not a plan. One thing. It could be: drink a glass of water, take a 5-minute walk, text one person you trust, or just sit quietly for 10 minutes without a screen.\n\nThird — tomorrow, do one more small thing.\n\nHealing and recovery are not linear and they are not fast. But small, consistent actions compound.\n\nWhat's the one thing you could realistically do in the next hour?";
    }

    // ── WELLNESS COACHING TOPICS ─────────────────────────────
    if (q.match(/meditat|mindful|present|calm down|relax|breathing|breath/)) {
      AI.lastTopic = 'mindfulness';
      return "Mindfulness is one of the most powerful tools we have — and it doesn't require an app or a special room.\n\nRight now, try this with me:\n\n1. Take one slow breath in through your nose for 4 counts\n2. Hold for 4 counts\n3. Out through your mouth for 6 counts\n\nDo that twice.\n\nWhen the mind is scattered, breathing is the fastest way back to the present moment. How do you feel after doing that? And is this something you want to build as a regular practice?";
    }

    if (q.match(/sleep|insomnia|can'?t sleep|wake up|tired|rest/)) {
      AI.lastTopic = 'sleep';
      return "Sleep issues are one of the most underestimated health problems. When sleep breaks down, everything else — mood, focus, relationships, physical health — starts to deteriorate.\n\nCan I ask a few things to understand yours better:\n\nIs it trouble falling asleep, staying asleep, or waking too early?\nHow long has this been happening?\nAnd what's typically going through your mind when you can't sleep — is it a racing mind, worry, or just can't switch off?";
    }

    if (q.match(/focus|concentrat|distract|productiv|motivation|procrastinat/)) {
      AI.lastTopic = 'focus';
      return "Focus struggles are almost never about willpower — they're usually about one of three things: mental overload, unclear priorities, or an environment fighting against you.\n\nI can see your current focus score is " + focus + "/100" + (bpm > 0 ? " and your blink rate is " + bpm + "/min." : ".") + "\n\nTell me more — when you try to focus, what actually happens? Does your mind wander to specific thoughts, do you get pulled to your phone, do you feel mentally foggy, or something else? The cause determines the fix.";
    }

    // GRIEF - must come BEFORE motivation so "lost my mom/dad/sister" never hits wrong topic
    if (q.match(/lost my (mom|mother|dad|father|sister|brother|son|daughter|wife|husband|partner|friend|pet|dog|cat|baby|child|grandma|grandpa|grandmother|grandfather)|passed away|she died|he died|they died|funeral|mourning|grieving|lost someone|death of/)) {
      AI.lastTopic = 'grief';
      return "I am so deeply sorry for your loss. Losing someone you love is one of the most painful experiences a person can go through — and there are no words that can make it better.\n\nI want you to know that I am here with you right now. You do not have to process this alone.\n\nCan you tell me about them? Or if you prefer, just tell me how you are feeling right now — whatever feels right.";
    }

    if (q.match(/motivat|inspire|purpose|meaning|direction|don'?t know what to do|stuck|no purpose/)) {
      AI.lastTopic = 'purpose';
      return "That feeling of being unmotivated or lost — it's more common than people admit, and it's often a signal, not a flaw.\n\nSometimes it means we've drifted from something that matters to us. Sometimes it means we're exhausted and our brain has nothing left for enthusiasm. Sometimes it means we need a new challenge.\n\nCan I ask: when was the last time you felt genuinely energised or excited about something? What were you doing? That memory is usually a clue.";
    }

    if (q.match(/confiden|self.esteem|self.worth|feel (stupid|dumb|useless|not enough|worthless)/)) {
      AI.lastTopic = 'self-esteem';
      return "The way we talk to ourselves matters enormously — and when confidence is low, the internal voice can be brutal.\n\nI want to ask you something: if a close friend said to you the things you say to yourself, how long would they remain your friend?\n\nYou reached out today. You're trying to understand yourself. That's not the behaviour of someone who is useless or not enough.\n\nWhat specifically triggered this feeling? Was it something that happened, something someone said, or is it more of a background feeling that's always there?";
    }

    if (q.match(/angry|anger|furious|rage|frustrated|irritated|snapping|losing it/)) {
      AI.lastTopic = 'anger';
      return "Anger is not a bad emotion — it's information. It usually means something important to you has been threatened or violated.\n\nThe question isn't how to make the anger go away. It's: what is the anger telling you?\n\nRight now, before we go deeper — can you do one physical thing: press your feet flat on the floor and take three slow breaths. Anger lives in the body and the body needs to release it before the mind can process it clearly.\n\nDone? Now tell me — what happened that set this off?";
    }

    if (q.match(/grief|loss|death|died|lost someone|mourning|miss (him|her|them|you)/)) {
      AI.lastTopic = 'grief';
      return "Grief is one of the most profound human experiences, and there is no right way to do it and no timeline for it.\n\nI'm so sorry for your loss. Whatever you're feeling right now — sadness, numbness, anger, even relief, or nothing at all — it's all valid.\n\nYou don't have to fix it or move through it faster. Can you tell me about them, or about what you're carrying right now? Sometimes just speaking it out loud matters.";
    }

    // ── THANKS / POSITIVE ────────────────────────────────────
    if (q.match(/thank|thanks|helpful|appreciate|that helped|feel better|much better/)) {
      return "I'm really glad that helped. 😊\n\nYou did the hard part — you showed up, you talked about what was real, and you were honest. That's not nothing.\n\nI'm here whenever you need to talk — whether it's about how you're feeling today, how to stay focused, or just to check in. Take care of yourself.";
    }

    // ── WHAT CAN YOU DO / PRESCRIPTIONS ─────────────────────
    if (q.match(/what can (i|you)|prescri|what should|action plan|steps|tips|how to feel|improve/)) {
      return "Based on what I can see and what you've shared, here is where I'd focus right now:\n\n" +
        (ear < thr * 0.8 ? "👁 Your eyes look tired — start by resting them. Close them for 30 seconds.\n\n" : "") +
        (focus < 50 ? "🧠 Focus is low at " + focus + "/100 — your mind needs one clear task, not a list. What is the single most important thing right now?\n\n" : "") +
        (bpm > 22 ? "😮‍💨 Your blink rate is high — take 3 slow, deliberate breaths right now.\n\n" : "") +
        "Beyond the immediate:\n1. Name one thing draining you that you could reduce or remove\n2. Name one thing that gives you energy that you've been neglecting\n3. Do the second one today — even for 15 minutes\n\nWhat feels most actionable for you right now?";
    }

    // ── ABOUT ARIA ────────────────────────────────────────────
    if (q.match(/who are you|what are you|your name|aria|about you|how do you work/)) {
      return "I'm Aria — an AI wellness coach built into Face AI Tracker.\n\nWhat makes me different from a regular chatbot: I can actually see your face. In real time, I'm reading your emotions, your eye fatigue, your focus level, and your posture. I use that data to personalise every response.\n\nBut I'm also here for conversations that go beyond metrics — stress, relationships, life challenges, mental performance, anything affecting your wellbeing.\n\nI'm not a replacement for a therapist or doctor. But I'm always here, I never judge, and I genuinely want to help. What would you like to talk about?";
    }

    // ── TESTING ───────────────────────────────────────────────
    if (q.match(/test|testing|is this working|hello world|can you hear/)) {
      return "Yes, I'm here and working! Here's what I can see right now:\n\n• Emotion: " + emotion + " (" + Math.round(conf * 100) + "% confidence)\n• Focus: " + focus + "/100\n• Eye openness: " + ear.toFixed(3) + "\n• Blink rate: " + (bpm > 0 ? bpm + "/min" : "measuring...") + "\n• Session: " + mins + " min\n\nEverything is running. Talk to me — about anything.";
    }

    // ── OFF TOPIC ─────────────────────────────────────────────
    if (q.match(/weather|news|sports|food|recipe|movie|music|game/)) {
      return "Ha — I appreciate you testing me! I'm a wellness coach so those topics are a bit outside my expertise. But if anything is affecting how you feel — stress about the news, using food for comfort, not sleeping well — I'm genuinely here for that.\n\nRight now your focus is " + focus + "/100 and you seem " + emotion + ". Anything on your mind?";
    }

    // ── ULTIMATE FALLBACK — conversational, never dead-end ───
    var fallbacks = [
      "I want to make sure I understand you properly. Can you tell me a bit more about what you mean? I'm listening.",
      "That's interesting — say more. What's behind that for you?",
      "I hear you. What's the main thing you want me to help with right now — is it something you're feeling, something you're thinking about, or something you want to do differently?",
      "I want to give you a useful response rather than a generic one. Can you share a bit more context about what's going on?",
    ];
    return fallbacks[Math.floor(AI.conversationDepth % fallbacks.length)];
  },
};


// ── CHAT ENGINE ──────────────────────────────────────────────

async function runAnalysis() {
  if (CHAT.isWaiting) return;
  if (CHAT.rateLimitedUntil > performance.now()) return;

  CHAT.isWaiting = true;
  showTypingIndicator();
  var faceData = collectFaceData();
  var response = null;

  // Try Gemini first — if server connected always use it
  if (CHAT.serverOnline) {
    try {
      var res = await fetch(CHAT.SERVER_URL + '/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emotion: faceData.emotion,
          emotionConfidence: faceData.emotionConfidence,
          focusScore: faceData.focusScore,
          blinkRate: faceData.blinkRate,
          blinkCount: faceData.blinkCount,
          ear: faceData.ear,
          headTilt: faceData.headTilt,
          headNod: faceData.headNod,
          sessionMs: faceData.sessionMs,
        }),
        signal: AbortSignal.timeout(15000),
      });
      var data = await res.json();
      if (res.ok && data.response) {
        response = data.response;
      } else if (res.status === 429) {
        CHAT.rateLimitedUntil = performance.now() + 3600000;
      }
    } catch (e) {
      console.warn('[auto-analyse] server error, using local');
    }
  }

  // Only use local if Gemini failed
  if (!response) {
    response = AI.observe(faceData);
    AI.observationCount++;
  }

  removeTypingIndicator();
  // Only show auto-analysis if no user message was sent recently (last 30s)
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
  addChatMessage('user', text);
  CHAT.lastUserMessageTime = performance.now();

  // Push user message to history before sending
  CHAT.history.push({ role: 'user', content: text });

  CHAT.isWaiting = true;
  showTypingIndicator();
  var faceData = collectFaceData();
  var response = null;
  var geminiError = null;

  // Always try Gemini when server connected
  if (CHAT.serverOnline && CHAT.rateLimitedUntil <= performance.now()) {
    try {
      var res = await fetch(CHAT.SERVER_URL + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message:  text,
          faceData: faceData,
          history:  CHAT.history.slice(-12),
        }),
        signal: AbortSignal.timeout(20000),
      });
      var data = await res.json();
      if (res.ok && data.response) {
        response = data.response;
      } else if (res.status === 429) {
        CHAT.rateLimitedUntil = performance.now() + 3600000;
        geminiError = 'quota';
        console.warn('[Aria] Gemini quota exceeded - using local fallback');
      } else if (data.error) {
        geminiError = data.error;
        console.warn('[Aria] Gemini error:', data.error);
      }
    } catch (e) {
      geminiError = e.message;
      console.warn('[Aria] Fetch failed:', e.message);
      // If server unreachable, mark offline so we stop trying
      if (e.name === 'TypeError' || e.name === 'AbortError') {
        CHAT.serverOnline = false;
        updateServerStatus(false);
      }
    }
  }

  // Local AI fallback - only when Gemini truly unavailable
  if (!response) {
    console.log('[Aria] Using local fallback. Gemini error:', geminiError);
    response = AI.answer(text, faceData);
  }

  removeTypingIndicator();
  addChatMessage('ai', response);
  CHAT.history.push({ role: 'assistant', content: response });
  if (CHAT.history.length > 20) CHAT.history.splice(0, 2);
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

// ═══════════════════════════════════════════════════════════════
// PWA INSTALL — Unified for Android/Desktop (beforeinstallprompt)
// and iOS Safari (manual Share → Add to Home Screen)
// ═══════════════════════════════════════════════════════════════

var deferredInstallPrompt = null;

// Android/Desktop Chrome: catch the browser install prompt
window.addEventListener('beforeinstallprompt', function(e) {
  e.preventDefault();
  deferredInstallPrompt = e;
  showInstallCard('android');
});

// Called when user clicks the big Install button (Android/Desktop)
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

// Dismiss the install card
function dismissInstall() {
  var card = document.getElementById('install-card');
  if (card) card.style.display = 'none';
  sessionStorage.setItem('install-dismissed', '1');
}

// Show the install card, configured for the right platform
function showInstallCard(platform) {
  if (sessionStorage.getItem('install-dismissed')) return;
  if (window.navigator.standalone === true) return; // Already installed on iOS

  var card      = document.getElementById('install-card');
  var btnMain   = document.getElementById('install-btn-main');
  var iosSteps  = document.getElementById('install-ios-steps');
  if (!card) return;

  card.style.display = 'block';

  if (platform === 'ios') {
    if (iosSteps) iosSteps.style.display = 'flex';
    if (btnMain)  btnMain.style.display  = 'none';
  } else {
    if (btnMain)  btnMain.style.display  = 'flex';
    if (iosSteps) iosSteps.style.display = 'none';
  }
}

// iOS Safari detection — show after 4 seconds
(function() {
  var isIOS       = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  var isSafari    = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  var isStandalone = window.navigator.standalone === true;

  if (isIOS && isSafari && !isStandalone) {
    setTimeout(function() { showInstallCard('ios'); }, 4000);
  }
})();

// Remove card if app gets installed
window.addEventListener('appinstalled', function() {
  dismissInstall();
  console.log('[PWA] App installed');
});