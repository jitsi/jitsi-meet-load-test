/* global $, config, JitsiMeetJS */

import 'jquery';

import { setConfigFromURLParams } from './configUtils';
import { parseURLParams } from './parseURLParams';
import { parseURIString } from './uri';
import { validateLastNLimits, limitLastN } from './lastN';

setConfigFromURLParams(config, {}, {}, window.location);

const params = parseURLParams(window.location, false, 'hash');
const { isHuman = false } = params;
const {
    localVideo = config.startWithVideoMuted !== true,
    remoteVideo = isHuman,
    remoteAudio = isHuman,
    autoPlayVideo = config.testing.noAutoPlayVideo !== true,
    stageView = config.disableTileView,
    numClients = 1,
    clientInterval = 100 // ms
} = params;

let {
    localAudio = config.disableInitialGUM !== true && config.startWithAudioMuted !== true
} = params;

const { room: roomName } = parseURIString(window.location.toString());

class LoadTestClient {
    constructor(id) {
        this.id = id;
        this.connection = null;
        this.connected = false;
        this.room = null;
        this.numParticipants = 1;
        this.localTracks = [];
        this.remoteTracks = {};
        this.maxFrameHeight = 0;
        this.selectedParticipant = null;
    }

    /**
     * Simple emulation of jitsi-meet's screen layout behavior
     */
    updateMaxFrameHeight() {
        if (!this.connected) {
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
                this.newMaxFrameHeight = 180;
            }
        }

        if (this.room && this.maxFrameHeight !== newMaxFrameHeight) {
            this.maxFrameHeight = newMaxFrameHeight;
            this.room.setReceiverVideoConstraint(this.maxFrameHeight);
        }
    }

    /**
     * Simple emulation of jitsi-meet's lastN behavior
     */
    updateLastN() {
        if (!this.connected) {
            return;
        }

        let lastN = typeof config.channelLastN === 'undefined' ? -1 : config.channelLastN;

        const limitedLastN = limitLastN(this.numParticipants, validateLastNLimits(config.lastNLimits));

        if (limitedLastN !== undefined) {
            lastN = lastN === -1 ? limitedLastN : Math.min(limitedLastN, lastN);
        }

        if (lastN === this.room.getLastN()) {
            return;
        }

        this.room.setLastN(lastN);
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
     * @returns Whether the selected participant changed.
     */
    selectStageViewParticipant(selected, previous) {
        let newSelectedParticipant;

        if (this.isValidStageViewParticipant(selected)) {
            newSelectedParticipant = selected;
        }
        else {
            newSelectedParticipant = previous.find(isValidStageViewParticipant);
        }
        if (newSelectedParticipant && newSelectedParticipant !== this.selectedParticipant) {
            this.selectedParticipant = newSelectedParticipant;
            return true;
        }
        return false;
    }

    /**
     * Simple emulation of jitsi-meet's selectParticipants behavior
     */
    selectParticipants() {
        if (!this.connected) {
            return;
        }
        if (stageView) {
            if (this.selectedParticipant) {
                this.room.selectParticipants([this.selectedParticipant]);
            }
        }
        else {
            /* jitsi-meet's current Tile View behavior. */
            const ids = this.room.getParticipants().map(participant => participant.getId());
            this.room.selectParticipants(ids);
        }
    }

    muteAudio(mute) {
        let localAudioTrack = this.room.getLocalAudioTrack();

        if (mute) {
            localAudioTrack?.mute();
        }
        else {
            if (localAudioTrack) {
                localAudioTrack.unmute();
            }
            else {
                // See if we created it but haven't added it.
                for (let i = 0; i < this.localTracks.length; i++) {
                    if (this.localTracks[i].getType() === 'audio') {
                        localAudioTrack = this.localTracks[i];
                        break;
                    }
                }
                if (localAudioTrack) {
                    localAudioTrack.unmute();
                    this.room.replaceTrack(null, localAudioTrack);
                }
                else {
                    JitsiMeetJS.createLocalTracks({ devices: ['audio'] })
                        .then(([audioTrack]) => audioTrack)
                        .catch(console.error)
                        .then(audioTrack => {
                            return this.room.replaceTrack(null, audioTrack);
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
        if (!stageView) {
            this.selectParticipants();
            this.updateMaxFrameHeight();
        }
        this.updateLastN();
    }

    /**
     * Called when ICE connects
     */
    onConnectionEstablished() {
        this.connected = true;

        this.selectParticipants();
        this.updateMaxFrameHeight();
        this.updateLastN();
    }

    /**
     * Handles dominant speaker changed.
     * @param id
     */
    onDominantSpeakerChanged(selected, previous) {
        if (this.selectStageViewParticipant(selected, previous)) {
            this.selectParticipants();
        }
        this.updateMaxFrameHeight();
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
                if (localAudio) {
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
        console.log(`Participant ${this.id} Conference joined`);
    }

    /**
     * Handles start muted events, when audio and/or video are muted due to
     * startAudioMuted or startVideoMuted policy.
     */
    onStartMuted() {
        // Give it some time, as it may be currently in the process of muting
        setTimeout(() => {
            const localAudioTrack = this.room.getLocalAudioTrack();

            if (localAudio && localAudioTrack && localAudioTrack.isMuted()) {
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
        console.debug(`Participant ${this.id}: Turning my video on!`);

        const localVideoTrack = this.room.getLocalVideoTrack();

        if (localVideoTrack && localVideoTrack.isMuted()) {
            console.debug(`Participant ${this.id}: Unmuting existing video track.`);
            localVideoTrack.unmute();
        } else if (!localVideoTrack) {
            JitsiMeetJS.createLocalTracks({ devices: ['video'] })
                .then(([videoTrack]) => videoTrack)
                .catch(console.error)
                .then(videoTrack => {
                    return this.room.replaceTrack(null, videoTrack);
                })
                .then(() => {
                    console.debug(`Participant ${this.id}: Successfully added a new video track for unmute.`);
                });
        } else {
            console.log(`Participant ${this.id}: No-op! We are already video unmuted!`);
        }
    }

    /**
     * This function is called to connect.
     */
    connect() {
        this._onConnectionSuccess = this.onConnectionSuccess.bind(this)
        this._onConnectionFailed = this.onConnectionFailed.bind(this)
        this._disconnect = this.disconnect.bind(this)

        this.connection = new JitsiMeetJS.JitsiConnection(null, null, config);
        this.connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_ESTABLISHED, this._onConnectionSuccess);
        this.connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_FAILED, this._onConnectionFailed);
        this.connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_DISCONNECTED, this._disconnect);
        this.connection.connect();
    }

    /**
     * That function is called when connection is established successfully
     */
    onConnectionSuccess() {
        this.room = this.connection.initJitsiConference(roomName.toLowerCase(), config);
        this.room.on(JitsiMeetJS.events.conference.STARTED_MUTED, this.onStartMuted.bind(this));
        this.room.on(JitsiMeetJS.events.conference.TRACK_ADDED, this.onRemoteTrack.bind(this));
        this.room.on(JitsiMeetJS.events.conference.CONFERENCE_JOINED, this.onConferenceJoined.bind(this));
        this.room.on(JitsiMeetJS.events.conference.CONNECTION_ESTABLISHED, this.onConnectionEstablished.bind(this));
        this.room.on(JitsiMeetJS.events.conference.USER_JOINED, this.onUserJoined.bind(this));
        this.room.on(JitsiMeetJS.events.conference.USER_LEFT, this.onUserLeft.bind(this));
        this.room.on(JitsiMeetJS.events.conference.PRIVATE_MESSAGE_RECEIVED, this.onPrivateMessage.bind(this));
        if (stageView) {
            this.room.on(JitsiMeetJS.events.conference.DOMINANT_SPEAKER_CHANGED, this.onDominantSpeakerChanged.bind(this));
        }

        const devices = [];

        if (localVideo) {
            devices.push('video');
        }

        if (!config.disableInitialGUM) {
            devices.push('audio');
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

        this.updateMaxFrameHeight();
    }

    /**
     * This function is called when the connection fail.
     */
    onConnectionFailed() {
        console.error(`Participant ${this.id}: Connection Failed!`);
    }

    /**
     * This function is called when we disconnect.
     */
    disconnect() {
        console.log('disconnect!');
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
        muteAudio(mute) {
            localAudio = !mute;
            for (let j = 0; j < clients.length; j++) {
                clients[j].muteAudio(mute);
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
        return clients[0]?.remoteParticipants;
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

JitsiMeetJS.setLogLevel(JitsiMeetJS.logLevels.ERROR);

JitsiMeetJS.init(config);

config.serviceUrl = config.bosh = `${config.websocket || config.bosh}?room=${roomName.toLowerCase()}`;
if (config.websocketKeepAliveUrl) {
    config.websocketKeepAliveUrl += `?room=${roomName.toLowerCase()}`;
}

function startClient(i) {
    clients[i] = new LoadTestClient(i);
    clients[i].connect();
    if (i + 1 < numClients) {
        setTimeout(() => { startClient(i+1) }, clientInterval)
    }
}

if (numClients > 0) {
    startClient(0)
}
