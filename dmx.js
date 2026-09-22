/* =========================================================
   DMX CONTROLLER
   DSD TECH SH-RS09B / USB-RS485
   Web Serial API
========================================================= */

class DMXController {

  constructor() {

    this.port = null;

    this.reader = null;

    this.writer = null;

    /*
      DMX512:

      Byte 0 = Start Code
      Byte 1-512 = DMX channels
    */

    this.universe =
      new Uint8Array(513);

    this.universe[0] = 0;

    this.connected = false;

    this.transmitting = false;

    this.frameTimer = null;

    this.frameInterval = 33;

    this.sending = false;

  }


  /* =========================================================
     CHECK SUPPORT
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
        "Web Serial wordt door deze browser niet ondersteund."
      );

    }


    /*
      Vraag gebruiker om een seriële poort.
    */

    this.port =
      await navigator.serial.requestPort();


    /*
      Open de seriële verbinding.

      DMX512 gebruikt:

      250000 baud
      8 databits
      geen parity
      2 stopbits
    */

    await this.port.open({

      baudRate: 250000,

      dataBits: 8,

      parity: "none",

      stopBits: 2,

      bufferSize: 1024,

      flowControl: "none"

    });


    this.connected = true;


    /*
      Writer ophalen.
    */

    this.writer =
      this.port.writable.getWriter();


    /*
      Start continue DMX-transmissie.
    */

    this.startTransmission();


    console.log(
      "DMX verbonden."
    );


    return true;

  }


  /* =========================================================
     DISCONNECT
  ========================================================= */

  async disconnect() {

    this.stopTransmission();


    this.connected = false;


    try {

      if (this.writer) {

        this.writer.releaseLock();

        this.writer = null;

      }

    } catch (error) {

      console.warn(
        "Writer kon niet worden vrijgegeven:",
        error
      );

    }


    try {

      if (this.port) {

        await this.port.close();

      }

    } catch (error) {

      console.warn(
        "Seriële poort kon niet worden gesloten:",
        error
      );

    }


    this.port = null;


    console.log(
      "DMX verbinding verbroken."
    );

  }


  /* =========================================================
     START CONTINUOUS TRANSMISSION
  ========================================================= */

  startTransmission() {

    if (this.transmitting) {

      return;

    }


    this.transmitting = true;


    /*
      Eerste frame meteen versturen.
    */

    this.sendFrame();


    /*
      Daarna ongeveer 30 FPS.
    */

    this.frameTimer =
      setInterval(
        () => {

          this.sendFrame();

        },
        this.frameInterval
      );

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
     SET CHANNEL
  ========================================================= */

  setChannel(
    channel,
    value
  ) {

    /*
      DMX kanalen lopen van 1 t/m 512.
    */

    if (
      channel < 1 ||
      channel > 512
    ) {

      return;

    }


    /*
      DMX waarde altijd 0-255.
    */

    value =
      Math.max(
        0,
        Math.min(
          255,
          Math.round(value)
        )
      );


    this.universe[channel] =
      value;

  }


  /* =========================================================
     CLEAR UNIVERSE
  ========================================================= */

  clearUniverse() {

    this.universe.fill(0);

    this.universe[0] = 0;

  }


  /* =========================================================
     GET STATE
  ========================================================= */

  getState() {

    if (
      typeof window.getDMXState !==
      "function"
    ) {

      console.error(
        "window.getDMXState() ontbreekt."
      );

      return null;

    }


    return window.getDMXState();

  }


  /* =========================================================
     HEX COLOR -> RGB
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
      hex.replace("#", "");


    /*
      Ondersteun eventueel #RGB.
    */

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
     MASTER CALCULATION
  ========================================================= */

  applyMaster(
    value,
    master
  ) {

    return Math.round(
      value *
      (master / 100)
    );

  }


  /* =========================================================
     SEND PAR
  ========================================================= */

  sendPar(index) {

    const state =
      this.getState();


    if (!state) {

      return;

    }


    if (
      !state.pars ||
      !state.pars[index]
    ) {

      return;

    }


    const par =
      state.pars[index];


    /*
      Iedere Compact Par gebruikt
      4 DMX kanalen:

      +0 Dimmer
      +1 Rood
      +2 Groen
      +3 Blauw
    */

    const startChannel =
      index * 4 + 1;


    const rgb =
      this.hexToRgb(
        par.color
      );


    const master =
      Number(state.master ?? 100);


    const dimmer =
      Number(par.dimmer ?? 0);


    /*
      PAR dimmer wordt gecombineerd
      met de Master dimmer.
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
      startChannel,
      finalDimmer
    );


    this.setChannel(
      startChannel + 1,
      finalRed
    );


    this.setChannel(
      startChannel + 2,
      finalGreen
    );


    this.setChannel(
      startChannel + 3,
      finalBlue
    );


    /*
      Als er een verbinding is,
      direct een nieuw frame sturen.
    */

    if (this.connected) {

      this.sendFrame();

    }

  }


  /* =========================================================
     SEND GENERIC DIMMER
  ========================================================= */

  sendDimmer(index) {

    const state =
      this.getState();


    if (!state) {

      return;

    }


    if (
      !state.dimmers ||
      !state.dimmers[index]
    ) {

      return;

    }


    const dimmer =
      state.dimmers[index];


    /*
      De losse dimmers beginnen
      na alle PAR-kanalen.

      Bijvoorbeeld:

      4 PARs × 4 kanalen = 16

      Dimmer 1 = kanaal 17
      Dimmer 2 = kanaal 18
      etc.
    */

    const startChannel =
      state.parCount * 4 +
      index +
      1;


    const value =
      Number(
        dimmer.dimmer ?? 0
      );


    const master =
      Number(
        state.master ?? 100
      );


    const finalValue =
      this.applyMaster(
        value * 2.55,
        master
      );


    this.setChannel(
      startChannel,
      finalValue
    );


    if (this.connected) {

      this.sendFrame();

    }

  }


  /* =========================================================
     SEND ALL
  ========================================================= */

  sendAll() {

    const state =
      this.getState();


    if (!state) {

      return;

    }


    /*
      Universe eerst volledig leegmaken.
    */

    this.clearUniverse();


    /*
      PARs.
    */

    if (Array.isArray(state.pars)) {

      state.pars.forEach(
        (_, index) => {

          this.writeParToUniverse(
            index,
            state
          );

        }
      );

    }


    /*
      Generic dimmers.
    */

    if (Array.isArray(state.dimmers)) {

      state.dimmers.forEach(
        (_, index) => {

          this.writeDimmerToUniverse(
            index,
            state
          );

        }
      );

    }


    /*
      Verstuur compleet universe.
    */

    if (this.connected) {

      this.sendFrame();

    }

  }


  /* =========================================================
     WRITE PAR TO UNIVERSE
  ========================================================= */

  writeParToUniverse(
    index,
    state
  ) {

    if (
      !state.pars ||
      !state.pars[index]
    ) {

      return;

    }


    const par =
      state.pars[index];


    const startChannel =
      index * 4 + 1;


    const rgb =
      this.hexToRgb(
        par.color
      );


    const master =
      Number(
        state.master ?? 100
      );


    const dimmer =
      Number(
        par.dimmer ?? 0
      );


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
      startChannel,
      finalDimmer
    );


    this.setChannel(
      startChannel + 1,
      finalRed
    );


    this.setChannel(
      startChannel + 2,
      finalGreen
    );


    this.setChannel(
      startChannel + 3,
      finalBlue
    );

  }


  /* =========================================================
     WRITE DIMMER TO UNIVERSE
  ========================================================= */

  writeDimmerToUniverse(
    index,
    state
  ) {

    if (
      !state.dimmers ||
      !state.dimmers[index]
    ) {

      return;

    }


    const dimmer =
      state.dimmers[index];


    const channel =
      state.parCount * 4 +
      index +
      1;


    const value =
      Number(
        dimmer.dimmer ?? 0
      );


    const master =
      Number(
        state.master ?? 100
      );


    const finalValue =
      this.applyMaster(
        value * 2.55,
        master
      );


    this.setChannel(
      channel,
      finalValue
    );

  }


  /* =========================================================
     SEND FRAME
  ========================================================= */

  async sendFrame() {

    if (!this.connected) {

      return;

    }


    if (!this.port) {

      return;

    }


    if (!this.writer) {

      return;

    }


    /*
      Voorkom dat meerdere frames
      tegelijk worden geschreven.
    */

    if (this.sending) {

      return;

    }


    this.sending = true;


    try {

      /*
        DMX vereist een BREAK vóór ieder frame.

        Web Serial ondersteunt op sommige
        adapters het veranderen van de
        RS232/serial signalen.

        Niet iedere USB-RS485 adapter/browser
        ondersteunt dit echter op dezelfde manier.
      */

      try {

        await this.port.setSignals({
          break: true
        });


        await this.sleep(1);


        await this.port.setSignals({
          break: false
        });


        await this.sleep(1);

      } catch (breakError) {

        /*
          Sommige adapters ondersteunen
          setSignals/break niet.

          We blijven dan proberen het
          universe te versturen.
        */

        console.warn(
          "DMX BREAK kon niet worden ingesteld:",
          breakError
        );

      }


      /*
        Schrijf het volledige DMX-frame.

        Byte 0 = startcode
        Byte 1-512 = DMX kanalen
      */

      await this.writer.write(
        this.universe
      );

    } catch (error) {

      console.error(
        "DMX frame kon niet worden verzonden:",
        error
      );


      /*
        Verbinding is mogelijk verbroken.
      */

      this.connected = false;

    } finally {

      this.sending = false;

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
   HANDLE DEVICE DISCONNECT
========================================================= */

if (
  "serial" in navigator
) {

  navigator.serial.addEventListener(
    "disconnect",
    async (event) => {

      /*
        Alleen reageren als dit
        daadwerkelijk onze poort is.
      */

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
