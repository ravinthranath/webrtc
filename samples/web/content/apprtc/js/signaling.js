/*
 *  Copyright (c) 2014 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */

/* More information about these options at jshint.com/docs/options */

/* globals addCodecParam, channelReady:true, displayError, displayStatus,
   gatheredIceCandidateTypes, hasLocalStream, iceCandidateType, localStream,
   maybePreferAudioReceiveCodec, maybePreferAudioSendCodec,
   maybeSetAudioReceiveBitRate, maybeSetAudioSendBitRate,
   maybeSetVideoReceiveBitRate, maybeSetVideoSendBitRate,
   maybeSetVideoSendInitialBitRate, mergeConstraints, msgQueue, onRemoteHangup,
   params, pc:true, remoteStream:true, remoteVideo, sdpConstraints, sharingDiv,
   signalingReady:true, webSocket:true, setupLoopback, startTime:true,
   started:true,  transitionToActive, turnDone, updateInfoDiv,
   waitForRemoteVideo */
/* exported openSignalingChannel */

'use strict';

function openSignalingChannel() {
  trace('Opening channel.');
  webSocket = new WebSocket(params.wssUrl);
  webSocket.onopen = onSignalingChannelOpen;
  webSocket.onmessage = onSignalingChannelMessage;
  webSocket.onerror = onSignalingChannelError;
  webSocket.onclose = onSignalingChannelClosed;

  if (params.isLoopback && (typeof setupLoopback === 'function')) {
    setupLoopback();
  }
}

function createPeerConnection() {
  try {
    var config = params.peerConnectionConfig;
    var constraints = params.peerConnectionConstraints;
    // Create an RTCPeerConnection via the polyfill (adapter.js).
    pc = new RTCPeerConnection(config, constraints);
    pc.onicecandidate = onIceCandidate;
    trace('Created RTCPeerConnnection with:\n' +
        '  config: \'' + JSON.stringify(config) + '\';\n' +
        '  constraints: \'' + JSON.stringify(constraints) + '\'.');
  } catch (e) {
    displayError('Failed to create PeerConnection, exception: ' + e.message);
    alert('Cannot create RTCPeerConnection object; WebRTC is not supported by this browser.');
    return;
  }
  pc.onaddstream = onRemoteStreamAdded;
  pc.onremovestream = onRemoteStreamRemoved;
  pc.onsignalingstatechange = onSignalingStateChanged;
  pc.oniceconnectionstatechange = onIceConnectionStateChanged;
}

function maybeStart() {
  if (!started && signalingReady && channelReady && turnDone &&
      (localStream || !hasLocalStream)) {
    startTime = window.performance.now();
    displayStatus('Connecting...');
    trace('Creating PeerConnection.');
    createPeerConnection();

    if (hasLocalStream) {
      trace('Adding local stream.');
      pc.addStream(localStream);
    } else {
      trace('Not sending any stream.');
    }
    started = true;

    if (params.isInitiator) {
      doCall();
    } else {
      calleeStart();
    }
  }
}

function doCall() {
  var constraints = mergeConstraints(params.offerConstraints, sdpConstraints);
  trace('Sending offer to peer, with constraints: \n\'' +
      JSON.stringify(constraints) + '\'.');
  pc.createOffer(setLocalAndSendMessage,
      onCreateSessionDescriptionError, constraints);
}

function calleeStart() {
  // Callee starts to process cached offer and other messages.
  while (msgQueue.length > 0) {
    processSignalingMessage(msgQueue.shift());
  }
}

function doAnswer() {
  trace('Sending answer to peer.');
  pc.createAnswer(setLocalAndSendMessage,
      onCreateSessionDescriptionError, sdpConstraints);
}

function setLocalAndSendMessage(sessionDescription) {
  sessionDescription.sdp = maybePreferAudioReceiveCodec(sessionDescription.sdp);
  sessionDescription.sdp = maybeSetAudioReceiveBitRate(sessionDescription.sdp);
  sessionDescription.sdp = maybeSetVideoReceiveBitRate(sessionDescription.sdp);
  pc.setLocalDescription(sessionDescription,
      onSetSessionDescriptionSuccess, onSetSessionDescriptionError);
  sendMessage(sessionDescription);
}

function setRemote(message) {
  // Set Opus in Stereo, if stereo enabled.
  if (params.isOpusStereo) {
    message.sdp = addCodecParam(message.sdp, 'opus/48000', 'stereo=1');
  }
  if (params.isOpus) {
    message.sdp = addCodecParam(message.sdp, 'opus/48000', 'useinbandfec=1');
  }
  // Set Opus maxplaybackrate, if requested.
  if (params.opusMaxPbr) {
    message.sdp = addCodecParam(message.sdp, 'opus/48000', 'maxplaybackrate=' +
        params.opusMaxPbr);
  }
  message.sdp = maybePreferAudioSendCodec(message.sdp);
  message.sdp = maybeSetAudioSendBitRate(message.sdp);
  message.sdp = maybeSetVideoSendBitRate(message.sdp);
  message.sdp = maybeSetVideoSendInitialBitRate(message.sdp);
  pc.setRemoteDescription(new RTCSessionDescription(message),
      onSetRemoteDescriptionSuccess, onSetSessionDescriptionError);

  function onSetRemoteDescriptionSuccess() {
    trace('Set remote session description success.');
    // By now all onaddstream events for the setRemoteDescription have fired,
    // so we can know if the peer has any remote video streams that we need
    // to wait for. Otherwise, transition immediately to the active state.
    // NOTE: Ideally we could just check |remoteStream| here, which is populated
    // in the onaddstream callback. But as indicated in
    // https://code.google.com/p/webrtc/issues/detail?id=3358, sometimes this
    // callback is dispatched after the setRemoteDescription success callback.
    // Therefore, we read the remoteStreams array directly from the
    // PeerConnection, which seems to work reliably.
    var remoteStreams = pc.getRemoteStreams();
    if (remoteStreams.length > 0 &&
        remoteStreams[0].getVideoTracks().length > 0) {
      trace('Waiting for remote video.');
      waitForRemoteVideo();
    } else {
      // TODO(juberti): Make this wait for ICE connection before transitioning.
      trace('No remote video stream; not waiting for media to arrive.');
      transitionToActive();
    }
  }
}

function sendMessage(message) {
  var wssMessage = {
    cmd: 'send',
    msg: JSON.stringify(message)
  };
  var msgString = JSON.stringify(wssMessage);
  trace('C->S: ' + msgString);
  if (channelReady) {
    webSocket.send(msgString);
  } else {
    var path = params.wssPostUrl + '/' + params.roomId + '/' + params.clientId;
    var xhr = new XMLHttpRequest();
    xhr.open('POST', path, true);
    xhr.setRequestHeader('Content-type', 'application/x-www-form-urlencoded');
    xhr.send('msg=' + encodeURIComponent(wssMessage.msg));
 }
}

function processSignalingMessage(message) {
  if (!started) {
    displayError('peerConnection has not been created yet!');
    return;
  }

  if (message.type === 'offer') {
    setRemote(message);
    doAnswer();
  } else if (message.type === 'answer') {
    setRemote(message);
  } else if (message.type === 'candidate') {
    var candidate = new RTCIceCandidate({
      sdpMLineIndex: message.label,
      candidate: message.candidate
    });
    noteIceCandidate('Remote', iceCandidateType(message.candidate));
    pc.addIceCandidate(candidate,
        onAddIceCandidateSuccess, onAddIceCandidateError);
  } else if (message.type === 'bye') {
    onRemoteHangup();
  }
}

function onAddIceCandidateSuccess() {
  trace('Remote candidate added successfully.');
}

function onAddIceCandidateError(error) {
  displayError('Failed to add remote candidate: ' + error.toString());
}

function onSignalingChannelOpen() {
  trace('Channel opened.');
  trace('Registering on Collider');
  var registerMessage = {
    cmd: 'register',
    roomid: params.roomId,
    clientid: params.clientId
  };
  webSocket.send(JSON.stringify(registerMessage));
  // TODO(tkchin): better notion of whether registration succeeded.
  channelReady = true;
  maybeStart();
}

function onSignalingChannelMessage(event) {
  var wssMessage;
  var message;
  try {
    wssMessage = JSON.parse(event.data);
    message = JSON.parse(wssMessage.msg);
  } catch (e) {
    trace('Error parsing JSON: ' + event.data); 
    return;
  }
  if (wssMessage.error) {
    trace('WSS error: ' + wssMessage.error);
    return;
  }
  trace('S->C: ' + wssMessage.msg);
  // Since the turn response is async and also GAE might disorder the
  // Message delivery due to possible datastore query at server side,
  // So callee needs to cache messages before peerConnection is created.
  if (!params.isInitiator && !started) {
    if (message.type === 'offer') {
      // Add offer to the beginning of msgQueue, since we can't handle
      // Early candidates before offer at present.
      msgQueue.unshift(message);
      // Callee creates PeerConnection
      signalingReady = true;
      maybeStart();
    } else {
      msgQueue.push(message);
    }
  } else {
    processSignalingMessage(message);
  }
}

function onSignalingChannelError() {
  displayError('Channel error.');
}

function onSignalingChannelClosed(event) {
  // TODO(tkchin): reconnect to WSS.
  trace('Channel closed with code:' + event.code + ' reason:' + event.reason);
  channelReady = false;
  webSocket = null;
}

function onCreateSessionDescriptionError(error) {
  displayError('Failed to create session description: ' + error.toString());
}

function onSetSessionDescriptionSuccess() {
  trace('Set session description success.');
}

function onSetSessionDescriptionError(error) {
  displayError('Failed to set session description: ' + error.toString());
}

function onIceCandidate(event) {
  if (event.candidate) {
    if (params.peerConnectionConfig.iceTransports === 'relay') {
      // Filter out non relay Candidates, if iceTransports is set to relay.
      if (event.candidate.candidate.search('relay') === -1) {
        return;
      }
    }
    sendMessage({
      type: 'candidate',
      label: event.candidate.sdpMLineIndex,
      id: event.candidate.sdpMid,
      candidate: event.candidate.candidate
    });
    noteIceCandidate('Local', iceCandidateType(event.candidate.candidate));
  } else {
    trace('End of candidates.');
  }
}

function onRemoteStreamAdded(event) {
  sharingDiv.classList.remove('active');
  trace('Remote stream added.');
  attachMediaStream(remoteVideo, event.stream);
  remoteStream = event.stream;
}

function onRemoteStreamRemoved() {
  trace('Remote stream removed.');
}

function onSignalingStateChanged() {
  if (pc) {
    trace('Signaling state changed to: ' + pc.signalingState);
  }
  updateInfoDiv();
}

function onIceConnectionStateChanged() {
  if (pc) {
    trace('ICE connection state changed to: ' + pc.iceConnectionState);
  }
  updateInfoDiv();
}

function noteIceCandidate(location, type) {
  var types = gatheredIceCandidateTypes[location];
  if (!types[type]) {
    types[type] = 1;
  } else {
    ++types[type];
  }
  updateInfoDiv();
}