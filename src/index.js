/* global $, config, JitsiMeetJS */

import _ from 'lodash';
import 'jquery';
import Logger, { getLogger } from '@jitsi/logger';

import { setConfigFromURLParams } from './configUtils';
import { parseURLParams } from './parseURLParams';
import { parseURIString } from './uri';
import { validateLastNLimits, limitLastN } from './lastN';
import JitsiMeetInMemoryLogStorage from './JitsiMeetInMemoryLogStorage';

const logger = getLogger('load-test-client');

setConfigFromURLParams(config, {}, {}, window.location);

const params = parseURLParams(window.location, false, 'hash');
const { isHuman = false } = params;
const {
    localVideo = config.startWithVideoMuted !== true,
    localAudio = !config.disableInitialGUM && !config.startWithAudioMuted,
    remoteVideo = isHuman,
    remoteAudio = isHuman,
    autoPlayVideo = config.testing.noAutoPlayVideo !== true,
    stageView = config.disableTileView,
    numClients = 1,
    clientInterval = 100 // ms
} = params;

const { room: roomName } = parseURIString(window.location.toString());

function appendURLParam(url, name, value) {
    const newUrl = new URL(url);

    newUrl.searchParams.append(name, value);

    return newUrl.toString();
}


class LoadTestClient {
    constructor(id, config) {
        this.id = id;
        this.connection = null;
        this.dataChannelOpen = false;
        this.room = null;
        this.numParticipants = 1;
        this.localTracks = [];
        this.remoteTracks = {};
        this.onStageParticipant = null;
        this.config = config;
        this.localAudio = localAudio;
        this.visitor = false;
        this.receiverConstraints = { onStageSources: [], defaultConstraints: {} };

        this.updateConfig();
    }

    updateConfig() {
        this.config.serviceUrl = this.config.bosh
            = appendURLParam(this.config.websocket || this.config.bosh, "room", roomName.toLowerCase());
        if (this.config.websocketKeepAliveUrl) {
            this.config.websocketKeepAliveUrl = appendURLParam(this.config.websocketKeepAliveUrl, "room", roomName.toLowerCase());
        }
    }

    /**
     * Simple emulation of jitsi-meet's receiver constraints behavior
     */
    updateReceiverConstraints(force = false) {
        if (!this.dataChannelOpen) {

            return;
        }

        let newMaxFrameHeight;

        if (stageView) {
            newMaxFrameHeight = 2160;
        }
        else {
            if (this.numParticipants <= 2) {
                newMaxFrameHeight = 720;
            } else if (this.numParticipants <= 4) {
                newMaxFrameHeight = 360;
            } else {
                newMaxFrameHeight = 180;
            }
        }

        let lastN = typeof this.config.channelLastN === 'undefined' ? -1 : this.config.channelLastN;

        const limitedLastN = limitLastN(this.numParticipants, validateLastNLimits(this.config.lastNLimits));

        if (limitedLastN !== undefined) {
            lastN = lastN === -1 ? limitedLastN : Math.min(limitedLastN, lastN);
        }

        let onStageSource;

        if (this.onStageParticipant) {
            const onStageParticipantTrack = this.room.jvbJingleSession?.peerconnection?.getRemoteTracks(this.onStageParticipant)?.find(track => track.getType() === 'video');
            if (onStageParticipantTrack) {
                onStageSource = onStageParticipantTrack.getSourceName();
            }
        }

        if (this.room) {
            if (force
                || this.receiverConstraints.lastN !== lastN
                || this.receiverConstraints.defaultConstraints.maxHeight !== newMaxFrameHeight
                || this.receiverConstraints.onStageSources[0] !== onStageSource) {
                    const newConstraints = _.cloneDeep(this.receiverConstraints);

                    newConstraints.lastN = lastN;
                    newConstraints.defaultConstraints.maxHeight = newMaxFrameHeight;
                    if (onStageSource) {
                        newConstraints.onStageSources[0] = onStageSource;
                    }
                    else {
                        newConstraints.onStageSources = [];
                    }

                    this.room.setReceiverConstraints(newConstraints);
                 }
        }
    }

    /**
     * Helper function to query whether a participant ID is a valid ID
     * for stage view.
     */
    isValidStageViewParticipant(id) {
        return (id !== room.myUserId() && room.getParticipantById(id));
    }

    /**
     * Simple emulation of jitsi-meet's stage view participant selection behavior.
     * Doesn't take into account pinning or screen sharing, and the initial behavior
     * is slightly different.
     * @returns Whether the on stage participant changed.
     */
    selectStageViewParticipant(selected, previous) {
        let newOnStageParticipant;

        if (this.isValidStageViewParticipant(selected)) {
            newOnStageParticipant = selected;
        }
        else {
            newOnStageParticipant = previous.find(isValidStageViewParticipant);
        }
        if (newOnStageParticipant && newOnStageParticipant !== this.onStageParticipant) {
            this.onStageParticipant = newOnStageParticipant;
            return true;
        }
        return false;
    }

    muteAudio(mute) {
        this.localAudio = !mute;

        let localAudioTrack = this.room.getLocalAudioTrack();

        if (mute) {
            localAudioTrack?.mute();
        }
        else {
            if (this.visitor) {
                logger.warn(`Participant ${this.id}: In visitor mode, not unmuting audio.`);
                return;
            }
            if (localAudioTrack) {
                localAudioTrack.unmute();
            }
            else {
                // See if we created it but haven't added it.
                localAudioTrack = this.localTracks.find(track => track.getType() === 'audio')
                if (localAudioTrack) {
                    localAudioTrack.unmute();
                    this.room.replaceTrack(null, localAudioTrack);
                }
                else {
                    JitsiMeetJS.createLocalTracks({ devices: ['audio'] })
                        .then(([audioTrack]) => audioTrack)
                        .catch(logger.error)
                        .then(audioTrack => {
                            return this.room.addTrack(audioTrack);
                        })
                }
            }
        }
    }

    /**
     * Called when number of participants changes.
     */
    setNumberOfParticipants() {
        if (this.id === 0) {
            $('#participants').text(this.numParticipants);
        }
        this.updateReceiverConstraints();
    }

    /**
     * Called when ICE connects
     */
    onDataChannelOpened() {
        this.dataChannelOpen = true;

        this.updateReceiverConstraints();
    }

    /**
     * Handles dominant speaker changed.
     * @param id
     */
    onDominantSpeakerChanged(selected, previous) {
        if (this.selectStageViewParticipant(selected, previous)) {
            this.updateReceiverConstraints();
        }
    }

    /**
     * Handles local tracks.
     * @param tracks Array with JitsiTrack objects
     */
    onLocalTracks(tracks = []) {
        this.localTracks = tracks;
        for (let i = 0; i < this.localTracks.length; i++) {
            if (this.localTracks[i].getType() === 'video') {
                if (this.id === 0) {
                    $('body').append(`<video ${autoPlayVideo ? 'autoplay="1" ' : ''}id='localVideo${i}' />`);
                    this.localTracks[i].attach($(`#localVideo${i}`)[0]);
                }

                this.room.addTrack(this.localTracks[i]);
            } else {
                if (this.localAudio) {
                    this.room.addTrack(this.localTracks[i]);
                } else {
                    this.localTracks[i].mute();
                }

                if (this.id === 0) {
                    $('body').append(
                        `<audio autoplay='1' muted='true' id='localAudio${i}' />`);
                    this.localTracks[i].attach($(`#localAudio${i}`)[0]);
                }
            }
        }
    }

    /**
     * Handles remote tracks
     * @param track JitsiTrack object
     */
    onRemoteTrack(track) {
        if (track.isLocal()
            || (track.getType() === 'video' && !remoteVideo) || (track.getType() === 'audio' && !remoteAudio)) {
            return;
        }
        const participant = track.getParticipantId();

        if (!this.remoteTracks[participant]) {
            this.remoteTracks[participant] = [];
        }

        if (this.id !== 0) {
            return;
        }

        const idx = this.remoteTracks[participant].push(track);
        const id = participant + track.getType() + idx;

        if (track.getType() === 'video') {
            $('body').append(`<video autoplay='1' id='${id}' />`);
        } else {
            $('body').append(`<audio autoplay='1' id='${id}' />`);
        }
        track.attach($(`#${id}`)[0]);
    }

    /**
     * That function is executed when the conference is joined
     */
    onConferenceJoined() {
        logger.log(`Participant ${this.id} Conference joined`);

        // Delay processing USER_JOINED events until the MUC is fully joined,
        // otherwise the apparent conference size will be wrong.
        this.numParticipants = this.room.getParticipantCount();
        this.setNumberOfParticipants();
        this.room.on(JitsiMeetJS.events.conference.USER_JOINED, this.onUserJoined.bind(this));
        this.room.on(JitsiMeetJS.events.conference._MEDIA_SESSION_STARTED, this.onMediaSessionStarted.bind(this));
    }

    /**
     * Handles start muted events, when audio and/or video are muted due to
     * startAudioMuted or startVideoMuted policy.
     */
    onStartMuted() {
        // Give it some time, as it may be currently in the process of muting
        setTimeout(() => {
            const localAudioTrack = this.room.getLocalAudioTrack();

            if (this.localAudio && localAudioTrack && localAudioTrack.isMuted()) {
                localAudioTrack.unmute();
            }

            const localVideoTrack = this.room.getLocalVideoTrack();

            if (localVideo && localVideoTrack && localVideoTrack.isMuted()) {
                localVideoTrack.unmute();
            }
        }, 2000);
    }

    /**
     *
     * @param id
     */
    onUserJoined(id) {
        this.numParticipants++;
        this.setNumberOfParticipants();
        this.remoteTracks[id] = [];
    }

    /**
     * Media session started.
     */
    onMediaSessionStarted() {
        this.updateReceiverConstraints(true);
    }

    /**
     *
     * @param id
     */
    onUserLeft(id) {
        this.numParticipants--;
        this.setNumberOfParticipants();
        if (!this.remoteTracks[id]) {
            return;
        }

        if (this.id !== 0) {
            return;
        }

        const tracks = this.remoteTracks[id];

        for (let i = 0; i < tracks.length; i++) {
            const container = $(`#${id}${tracks[i].getType()}${i + 1}`)[0];

            if (container) {
                tracks[i].detach(container);
                container.parentElement.removeChild(container);
            }
        }
    }

    /**
     * Handles private messages.
     *
     * @param {string} id - The sender ID.
     * @param {string} text - The message.
     * @returns {void}
     */
    onPrivateMessage(id, text) {
        switch (text) {
            case 'video on':
                this.onVideoOnMessage();
                break;
        }
    }

    /**
     * Handles 'video on' private messages.
     *
     * @returns {void}
     */
    onVideoOnMessage() {
        if (this.visitor) {
            logger.warn(`Participant ${this.id}: In visitor mode, not turning video on.`);
            return;
        }

        logger.debug(`Participant ${this.id}: Turning my video on!`);

        const localVideoTrack = this.room.getLocalVideoTrack();

        if (localVideoTrack && localVideoTrack.isMuted()) {
            logger.debug(`Participant ${this.id}: Unmuting existing video track.`);
            localVideoTrack.unmute();
        } else if (!localVideoTrack) {
            JitsiMeetJS.createLocalTracks({ devices: ['video'] })
                .then(([videoTrack]) => videoTrack)
                .catch(logger.error)
                .then(videoTrack => {
                    return this.room.replaceTrack(null, videoTrack);
                })
                .then(() => {
                    logger.debug(`Participant ${this.id}: Successfully added a new video track for unmute.`);
                });
        } else {
            logger.log(`Participant ${this.id}: No-op! We are already video unmuted!`);
        }
    }

    onConferenceFailed(error, vnode, from) {
        if (error !== JitsiMeetJS.errors.conference.REDIRECTED) {
            logger.error(error);
            return;
        }
    }

    onConnectionRedirected(vnode, focusJid) {
        logger.log(`Participant ${this.id}: redirecting to visitor node ${vnode} with focusJid=${focusJid}`);
        this.connection.disconnect().then(() => {
            this.visitor = true;
            const oldDomain = this.config.hosts.domain;

            this.config.hosts.domain = `${vnode}.meet.jitsi`;
            //this.config.visitorTo = `${roomName.toLowerCase()}@${this.config.hosts.muc}`;
            this.config.hosts.muc = this.config.hosts.muc.replace(oldDomain, this.config.hosts.domain);
            this.config.focusUserJid = focusJid;
            this.config.disableFocus = true;

            this.config.bosh = appendURLParam(this.config.bosh, "vnode", vnode);
            this.config.websocket = appendURLParam(this.config.websocket, "vnode", vnode);
            this.config.websocketKeepAliveUrl = appendURLParam(this.config.websocketKeepAliveUrl, "vnode", vnode);

            this.localTracks.forEach((track) => track.mute());

            this.updateConfig();
            this.connect();
        });
    }

    /**
     * This function is called to connect.
     */
    connect() {
        this._onConnectionSuccess = this.onConnectionSuccess.bind(this)
        this._onConnectionFailed = this.onConnectionFailed.bind(this)
        this._onConnectionRedirected = this.onConnectionRedirected.bind(this)
        this._disconnect = this.disconnect.bind(this)

        const params = parseURLParams(window.location, true, 'search');

        this.connection = new JitsiMeetJS.JitsiConnection(null, params.jwt, this.config);
        this.connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_ESTABLISHED, this._onConnectionSuccess);
        this.connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_FAILED, this._onConnectionFailed);
        this.connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_DISCONNECTED, this._disconnect);
        this.connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_REDIRECTED, this._onConnectionRedirected);
        this.connection.connect({ name: roomName });
    }

    /**
     * That function is called when connection is established successfully
     */
    onConnectionSuccess() {
        this.room = this.connection.initJitsiConference(roomName.toLowerCase(), this.config);
        this.room.on(JitsiMeetJS.events.conference.STARTED_MUTED, this.onStartMuted.bind(this));
        this.room.on(JitsiMeetJS.events.conference.TRACK_ADDED, this.onRemoteTrack.bind(this));
        this.room.on(JitsiMeetJS.events.conference.CONFERENCE_JOINED, this.onConferenceJoined.bind(this));
        this.room.on(JitsiMeetJS.events.conference.DATA_CHANNEL_OPENED, this.onDataChannelOpened.bind(this));
        this.room.on(JitsiMeetJS.events.conference.USER_LEFT, this.onUserLeft.bind(this));
        this.room.on(JitsiMeetJS.events.conference.PRIVATE_MESSAGE_RECEIVED, this.onPrivateMessage.bind(this));
        this.room.on(JitsiMeetJS.events.conference.CONFERENCE_FAILED, this.onConferenceFailed.bind(this));
        if (stageView) {
            this.room.on(JitsiMeetJS.events.conference.DOMINANT_SPEAKER_CHANGED, this.onDominantSpeakerChanged.bind(this));
        }

        const devices = [];

        if (!this.visitor) {
            if (localVideo) {
                devices.push('video');
            }

            if (!config.disableInitialGUM) {
                devices.push('audio');
            }
        }

        if (devices.length > 0) {
            JitsiMeetJS.createLocalTracks({ devices })
                .then(this.onLocalTracks.bind(this))
                .then(() => {
                    this.room.join();
                })
                .catch(error => {
                    throw error;
                });
        } else {
            this.room.join();
        }
    }

    /**
     * This function is called when the connection fail.
     */
    onConnectionFailed() {
        logger.error(`Participant ${this.id}: Connection Failed!`);
    }

    /**
     * This function is called when we disconnect.
     */
    disconnect() {
        logger.log('disconnect!');
        this.connection.removeEventListener(
            JitsiMeetJS.events.connection.CONNECTION_ESTABLISHED,
            this._onConnectionSuccess);
        this.connection.removeEventListener(
            JitsiMeetJS.events.connection.CONNECTION_FAILED,
            this._onConnectionFailed);
        this.connection.removeEventListener(
            JitsiMeetJS.events.connection.CONNECTION_DISCONNECTED,
            this._disconnect);
    }
}


let clients = [];

window.APP = {
    conference: {
        getStats() {
            return clients[0]?.room?.connectionQuality.getStats();
        },
        getConnectionState() {
            return clients[0] && clients[0].room && room.getConnectionState();
        },
        muteAudio(mute, num) {
            if (num === undefined) {
                for (let j = 0; j < clients.length; j++) {
                    clients[j].muteAudio(mute);
                }
            }
            else {
                clients[num].muteAudio(mute);
            }
        }
    },

    get room() {
        return clients[0]?.room;
    },
    get connection() {
        return clients[0]?.connection;
    },
    get numParticipants() {
        return clients[0]?.numParticipants;
    },
    get localTracks() {
        return clients[0]?.localTracks;
    },
    get remoteTracks() {
        return clients[0]?.remoteTracks;
    },
    get params() {
        return {
            roomName,
            localAudio,
            localVideo,
            remoteVideo,
            remoteAudio,
            autoPlayVideo,
            stageView
        };
    }
};

/**
 *
 */
function unload() {
    for (let j = 0; j < clients.length; j++) {
        for (let i = 0; i < clients[j].localTracks.length; i++) {
            clients[j].localTracks[i].dispose();
        }
        clients[j].room.leave();
        clients[j].connection.disconnect();
    }
    clients = [];
}

$(window).bind('beforeunload', unload);
$(window).bind('unload', unload);

JitsiMeetJS.setLogLevel(JitsiMeetJS.logLevels.TRACE);
APP.debugLogs = new JitsiMeetInMemoryLogStorage();
const debugLogCollector = new Logger.LogCollector(APP.debugLogs, { storeInterval: 1000 });

Logger.addGlobalTransport(debugLogCollector);
JitsiMeetJS.addGlobalLogTransport(debugLogCollector);
debugLogCollector.start();

JitsiMeetJS.init(config);

function startClient(i) {
    // dirty copy of the config to be per client
    clients[i] = new LoadTestClient(i, JSON.parse(JSON.stringify(config)));
    clients[i].connect();
    if (i + 1 < numClients) {
        setTimeout(() => { startClient(i+1) }, clientInterval)
    }
}

if (numClients > 0) {
    startClient(0)
}
