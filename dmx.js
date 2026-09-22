/* =========================================================
   DMX CONTROLLER
   DSD TECH SH-RS09B
   DMX: 250000 baud / 8N2

   Belangrijk:
   - 1 vaste DMX-loop
   - geen parallelle writes
   - geen sendFrame() bij iedere sliderbeweging
   - universe wordt opgebouwd vanuit de actuele UI-state
========================================================= */

class DMXController {

  constructor() {

    this.port = null;

    this.writer = null;

    this.connected = false;

    this.transmitting = false;

    this.frameTimer = null;

    /*
      Eén frame per seconde.
    */

    this.frameInterval = 1000;

    /*
      513 bytes:

      byte 0   = startcode
      byte 1   = kanaal 1
      ...
      byte 512 = kanaal 512
    */

    this.universe =
      new Uint8Array(513);

    this.universe[0] = 0;

    /*
      Voorkom dat meerdere frames
      tegelijkertijd naar USB gaan.
    */

    this.writeBusy = false;

    /*
      Als tijdens een write een nieuw
      frame nodig is, zetten we deze vlag.
    */

    this.frameRequested = false;

    this.breakSupported = null;

    this.frameCount = 0;

    this.lastLogTime = 0;

    this.lastFrameStart = 0;

    this.debug = true;

  }


  /* =========================================================
     SUPPORT
  ========================================================= */

  isSupported() {

    return (
      "serial" in navigator
    );

  }


  /* =========================================================
     CONNECT
  ========================================================= */

  async connect() {

    if (!this.isSupported()) {

      throw new Error(
        "Web Serial wordt niet ondersteund."
      );

    }


    /*
      Als er al een verbinding is,
      niet opnieuw openen.
    */

    if (
      this.connected &&
      this.port
    ) {

      return true;

    }


    this.port =
      await navigator.serial.requestPort();

    console.info(
      "[DMX] Poort geselecteerd:",
      this.port.getInfo()
    );


    await this.port.open({

      baudRate: 250000,

      dataBits: 8,

      parity: "none",

      stopBits: 2,

      bufferSize: 1024,

      flowControl: "none"

    });


    this.writer =
      this.port.writable.getWriter();


    this.connected = true;

    console.info(
      "[DMX] Verbonden: 250000 baud, 8N2, frame-interval:",
      `${this.frameInterval} ms`
    );


    this.startTransmission();


    console.log(
      "DMX verbonden"
    );


    return true;

  }


  /* =========================================================
     DISCONNECT
  ========================================================= */

  async disconnect() {

    this.stopTransmission();


    this.connected = false;


    if (this.writer) {

      try {

        this.writer.releaseLock();

      } catch (error) {

        console.warn(
          error
        );

      }

      this.writer = null;

    }


    if (this.port) {

      try {

        await this.port.close();

      } catch (error) {

        console.warn(
          "Poort sluiten:",
          error
        );

      }

    }


    this.port = null;

  }


  /* =========================================================
     START TRANSMISSION
  ========================================================= */

  startTransmission() {

    if (this.transmitting) {

      return;

    }


    this.transmitting = true;


    /*
      Eén vaste loop.

      De loop maakt steeds opnieuw
      het actuele DMX-universe.
    */

    this.frameTimer =
      setInterval(
        () => {

          this.requestFrame();

        },
        this.frameInterval
      );


    /*
      Meteen een eerste frame.
    */

    this.requestFrame();

  }


  /* =========================================================
     FRAME INTERVAL
  ========================================================= */

  setFrameInterval(milliseconds) {

    const nextInterval = Math.max(
      25,
      Math.min(
        5000,
        Math.round(Number(milliseconds) || 1000)
      )
    );

    this.frameInterval = nextInterval;

    if (this.frameTimer) {

      clearInterval(this.frameTimer);

      this.frameTimer = setInterval(
        () => this.requestFrame(),
        this.frameInterval
      );

    }

    if (this.debug) {

      console.info(
        "[DMX] Frame-interval ingesteld:",
        `${this.frameInterval} ms`
      );

    }

  }


  /* =========================================================
     STOP TRANSMISSION
  ========================================================= */

  stopTransmission() {

    this.transmitting = false;


    if (this.frameTimer) {

      clearInterval(
        this.frameTimer
      );

      this.frameTimer = null;

    }

  }


  /* =========================================================
     REQUEST FRAME
  ========================================================= */

  requestFrame() {

    /*
      Als er al een write bezig is,
      hoeft er geen tweede write gestart
      te worden.

      Het volgende frame wordt later
      vanzelf door de timer aangevraagd.
    */

    if (this.writeBusy) {

      this.frameRequested = true;

      return;

    }


    this.frameRequested = false;


    this.buildUniverse();


    this.sendFrame();

  }


  /* =========================================================
     BUILD UNIVERSE
  ========================================================= */

  buildUniverse() {

    this.universe.fill(0);

    this.universe[0] = 0;


    const state =
      this.getState();


    if (!state) {

      return;

    }


    /*
      PARs
    */

    if (
      Array.isArray(state.pars)
    ) {

      state.pars.forEach(
        (par) => {

          this.writePar(
            par,
            state.master
          );

        }
      );

    }


    /*
      Dimmers
    */

    if (
      Array.isArray(state.dimmers)
    ) {

      state.dimmers.forEach(
        (dimmer, index) => {

          this.writeDimmer(
            dimmer,
            index,
            state
          );

        }
      );

    }

    this.logStateSummary(state);

  }


  /* =========================================================
     DEBUG LOGGING
  ========================================================= */

  logStateSummary(state) {

    if (!this.debug) {
      return;
    }

    const now = performance.now();

    if (now - this.lastLogTime < 1000) {
      return;
    }

    this.lastLogTime = now;

    const usedChannels = [];

    if (Array.isArray(state.pars)) {

      state.pars.forEach((par, index) => {

        const address = Math.round(Number(par?.address));

        if (Number.isFinite(address)) {

          for (let offset = 0; offset < 4; offset++) {
            usedChannels.push({
              channel: address + offset,
              source: `PAR ${index + 1}`
            });
          }

        }

      });

    }

    if (Array.isArray(state.dimmers)) {

      state.dimmers.forEach((dimmer, index) => {

        usedChannels.push({
          channel: Number(state.parCount) * 4 + index + 1,
          source: `Dimmer ${index + 1}`
        });

      });

    }

    const channelOwners = new Map();

    usedChannels.forEach(({ channel, source }) => {

      if (channelOwners.has(channel)) {

        console.warn(
          `[DMX] Kanaalconflict op kanaal ${channel}:`,
          channelOwners.get(channel),
          "en",
          source
        );

      } else {

        channelOwners.set(channel, source);

      }

    });

    console.debug(
      "[DMX] State:",
      `${state.pars?.length || 0} PAR(s),`,
      `${state.dimmers?.length || 0} dimmer(s),`,
      `master ${state.master}%`
    );

  }


  /* =========================================================
     GET STATE
  ========================================================= */

  getState() {

    if (
      typeof window.getDMXState !==
      "function"
    ) {

      return null;

    }


    return window.getDMXState();

  }


  /* =========================================================
     SET CHANNEL
  ========================================================= */

  setChannel(
    channel,
    value
  ) {

    channel =
      Math.round(
        Number(channel)
      );


    value =
      Math.round(
        Number(value)
      );


    if (
      channel < 1 ||
      channel > 512
    ) {

      return;

    }


    value =
      Math.max(
        0,
        Math.min(
          255,
          value
        )
      );


    this.universe[channel] =
      value;

  }


  /* =========================================================
     HEX -> RGB
  ========================================================= */

  hexToRgb(hex) {

    if (
      typeof hex !== "string"
    ) {

      return {
        r: 0,
        g: 0,
        b: 0
      };

    }


    let clean =
      hex.replace(
        "#",
        ""
      );


    if (clean.length === 3) {

      clean =
        clean
          .split("")
          .map(
            char =>
              char + char
          )
          .join("");

    }


    if (clean.length !== 6) {

      return {
        r: 0,
        g: 0,
        b: 0
      };

    }


    return {

      r: parseInt(
        clean.substring(0, 2),
        16
      ),

      g: parseInt(
        clean.substring(2, 4),
        16
      ),

      b: parseInt(
        clean.substring(4, 6),
        16
      )

    };

  }


  /* =========================================================
     MASTER
  ========================================================= */

  applyMaster(
    value,
    master
  ) {

    const m =
      Math.max(
        0,
        Math.min(
          100,
          Number(master ?? 100)
        )
      );


    return Math.round(
      Number(value) *
      (m / 100)
    );

  }


  /* =========================================================
     WRITE PAR
     
     4 CHANNEL MODE:

     +0 Dimmer
     +1 Red
     +2 Green
     +3 Blue
  ========================================================= */

  writePar(
    par,
    master
  ) {

    if (!par) {
      return;
    }


    let address =
      Number(par.address);


    /*
      PAR heeft 4 kanalen.

      Hoogste veilige startadres = 509.
    */

    if (
      !Number.isFinite(address)
    ) {

      return;

    }


    address =
      Math.max(
        1,
        Math.min(
          509,
          Math.round(address)
        )
      );


    const rgb =
      this.hexToRgb(
        par.color
      );


    const dimmer =
      Math.max(
        0,
        Math.min(
          100,
          Number(par.dimmer ?? 0)
        )
      );


    /*
      De master wordt alleen op de
      output toegepast.
    */

    const finalDimmer =
      this.applyMaster(
        dimmer * 2.55,
        master
      );


    const finalRed =
      this.applyMaster(
        rgb.r,
        master
      );


    const finalGreen =
      this.applyMaster(
        rgb.g,
        master
      );


    const finalBlue =
      this.applyMaster(
        rgb.b,
        master
      );


    this.setChannel(
      address,
      finalDimmer
    );


    this.setChannel(
      address + 1,
      finalRed
    );


    this.setChannel(
      address + 2,
      finalGreen
    );


    this.setChannel(
      address + 3,
      finalBlue
    );

  }


  /* =========================================================
     WRITE GENERIC DIMMER
     
     Dimmers blijven na de PAR-kanalen
     volgens de bestaande app-indeling.
  ========================================================= */

  writeDimmer(
    dimmer,
    index,
    state
  ) {

    if (!dimmer) {
      return;
    }


    const fallbackAddress =
      Number(state.parCount) * 4 +
      index +
      1;

    const address =
      Number.isFinite(Number(dimmer.address))
        ? Number(dimmer.address)
        : fallbackAddress;


    const value =
      Math.max(
        0,
        Math.min(
          100,
          Number(dimmer.dimmer ?? 0)
        )
      );


    const finalValue =
      this.applyMaster(
        value * 2.55,
        state.master
      );


    this.setChannel(
      address,
      finalValue
    );

  }


  /* =========================================================
     COMPATIBILITY FUNCTIONS
     
     Deze functies bestaan nog steeds zodat
     de HTML ze eventueel kan aanroepen.

     Ze starten GEEN extra DMX-write.
     De vaste loop pakt de wijziging vanzelf op.
  ========================================================= */

  sendPar(index) {

    /*
      Geen directe USB write.

      De volgende frame van de vaste
      DMX-loop neemt de nieuwe waarde mee.
    */

    this.requestFrame();

  }


  sendDimmer(index) {

    /*
      Geen directe USB write.
    */

    this.requestFrame();

  }


  sendAll() {

    /*
      Universe opnieuw opbouwen.
    */

    this.requestFrame();

  }


  /* =========================================================
     SEND FRAME
  ========================================================= */

  async sendFrame() {

    if (
      !this.connected ||
      !this.port ||
      !this.writer
    ) {

      return;

    }


    /*
      Nooit twee writes tegelijkertijd.
    */

    if (this.writeBusy) {

      this.frameRequested = true;

      return;

    }


    this.writeBusy = true;

    this.lastFrameStart = performance.now();


    try {

      /*
        Maak het universe vlak voor
        verzending opnieuw.

        Hierdoor worden wijzigingen die
        tijdens de loop zijn gemaakt
        zo snel mogelijk meegenomen.
      */

      this.buildUniverse();


      /*
        BREAK

        Niet iedere USB-RS485 adapter/browser
        ondersteunt setSignals({break:true}).

        Als het ondersteund wordt,
        gebruiken we het.
      */

      let breakSupported = this.breakSupported !== false;


      if (breakSupported) {

        try {

          await this.port.setSignals({
            break: true
          });

          this.breakSupported = true;

        } catch (error) {

          this.breakSupported = false;

          breakSupported = false;

          console.warn(
            "[DMX] BREAK wordt niet ondersteund door deze browser/adapter. DMX kan daardoor knipperen.",
            error
          );

        }

      }


      if (breakSupported) {

        /*
          BREAK minimaal ongeveer 88 µs.

          1 ms is ruim voldoende.
        */

        await this.sleep(1);


        await this.port.setSignals({
          break: false
        });


        /*
          Mark After Break.
        */

        await this.sleep(1);

      }


      /*
        Eén volledige DMX universe-write.
      */

      await this.writer.write(
        this.universe
      );

      this.frameCount += 1;

      const frameDuration =
        performance.now() - this.lastFrameStart;

      if (
        this.debug &&
        (this.frameCount === 1 ||
          this.frameCount % 40 === 0)
      ) {

        console.info(
          "[DMX] Frame verzonden:",
          this.frameCount,
          `(${Math.round(frameDuration)} ms, BREAK: ${breakSupported ? "ja" : "nee"})`
        );

      }

    } catch (error) {

      console.error(
        "[DMX] Verzending mislukt; verbinding wordt gestopt:",
        error
      );


      this.connected = false;

    } finally {

      this.writeBusy = false;


      /*
        Als er tijdens het schrijven
        een wijziging is geweest, hoeft
        niet gewacht te worden op de
        volgende timer-tick.
      */

      if (
        this.frameRequested &&
        this.connected
      ) {

        this.frameRequested = false;

        /*
          Via microtask/timeout voorkomen
          we recursieve calls.
        */

        setTimeout(
          () => this.requestFrame(),
          0
        );

      }

    }

  }


  /* =========================================================
     SLEEP
  ========================================================= */

  sleep(milliseconds) {

    return new Promise(
      resolve =>
        setTimeout(
          resolve,
          milliseconds
        )
    );

  }

}


/* =========================================================
   GLOBAL INSTANCE
========================================================= */

window.dmx =
  new DMXController();


/* =========================================================
   USB DISCONNECT
========================================================= */

if (
  "serial" in navigator
) {

  navigator.serial.addEventListener(
    "disconnect",
    async event => {

      if (
        window.dmx &&
        window.dmx.port ===
        event.target
      ) {

        await window.dmx.disconnect();


        const status =
          document.getElementById(
            "connectionStatus"
          );

        const statusText =
          document.getElementById(
            "statusText"
          );

        const connectButton =
          document.getElementById(
            "connectBtn"
          );


        if (status) {

          status.classList.remove(
            "connected"
          );

        }


        if (statusText) {

          statusText.textContent =
            "DMX losgekoppeld";

        }


        if (connectButton) {

          connectButton.disabled =
            false;

          connectButton.textContent =
            "Verbinden";

        }

      }

    }
  );

}
