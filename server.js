
const express = require("express");
const SerialPort = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

const app = express();
app.use(express.static("public")); // folder with index.html, script.js, style.css

// IMPORTANT: adjust COM port if needed (check Device Manager / Arduino IDE)
const port = new SerialPort.SerialPort({
  path: "COM18",     // <-- change if your board shows a different COM
  baudRate: 9600     // must match Serial.begin(9600) on MCU
});

port.on("open", () => {
  console.log("Serial port opened on COM18 at 9600 baud");
});

port.on("error", (err) => {
  console.error("Serial port error:", err.message);
});

// MCU uses Serial.println(...) → lines end with \r\n
const parser = port.pipe(new ReadlineParser({ delimiter: "\r\n" }));

let sensorData = {};

parser.on("data", (line) => {
  console.log("RAW from MCU:", JSON.stringify(line));

  try {
    sensorData = JSON.parse(line);
    console.log("Parsed sensorData:", sensorData);
  } catch (e) {
    console.error("Failed to parse JSON from MCU:", e.message);
  }
});

app.get("/data", (req, res) => {
  res.json(sensorData); // frontend expects keys: voltage, current, power, energy
});

app.listen(3000, () => console.log("Server running on http://localhost:3000"));