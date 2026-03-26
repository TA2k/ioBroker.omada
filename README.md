![Logo](admin/omada.png)

# ioBroker.omada

[![NPM version](https://img.shields.io/npm/v/iobroker.omada.svg)](https://www.npmjs.com/package/iobroker.omada)
[![Downloads](https://img.shields.io/npm/dm/iobroker.omada.svg)](https://www.npmjs.com/package/iobroker.omada)
![Number of Installations](https://iobroker.live/badges/omada-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/omada-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.omada.png?downloads=true)](https://nodei.co/npm/iobroker.omada/)

**Tests:** ![Test and Release](https://github.com/TA2k/ioBroker.omada/workflows/Test%20and%20Release/badge.svg)

## omada adapter for ioBroker

Adapter for TP-Link Omada

**Voraussetzung:** Omada SDN Controller >= 6.2.0

# Loginablauf

Die Omada IP, Login und Passwort eingeben.
Default Port für Hardware Controller ist 443

# Steuerung

Ssids Einstellungen können via omada.0.id.ssids geändert werden

## Diskussion und Fragen

<https://forum.iobroker.net/topic/62562/test-adapter-omada-tp-link>

## Changelog

### 0.1.0 (2026-03-26)

- (BREAKING) Erfordert Omada SDN Controller >= 6.2.0
- Clients-Endpunkt auf OpenAPI v2 (POST) umgestellt
- Omada-Request-Source Header hinzugefügt
- Fehlerbehebung: Aufgelöste URL wird im Error-Log angezeigt

### 0.0.1

- (TA2k) initial release

## License

MIT License

Copyright (c) 2023 TA2k <tombox2020@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
