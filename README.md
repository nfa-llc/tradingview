# gexbot TradingView v1.0

## Source-available license notice

Copyright © Not Financial Advice, LLC. All rights reserved.

This TradingView integration is source available. It is not open-source software.

This TradingView integration is licensed under the PolyForm Noncommercial License 1.0.0.

You may use, copy, modify, and share this integration only for noncommercial purposes and only in accordance with that license.

Commercial use is not permitted without a separate written commercial license from Not Financial Advice, LLC.

For clarity, prohibited commercial use includes, without limitation:

- using, modifying, adapting, or distributing this integration in connection with any paid product, paid service, subscription service, brokerage service, trading platform, market-data service, analytics service, signal service, or other commercial offering;
- replacing, adapting, or configuring the integration to operate with a third-party or competing commercial data feed;
- incorporating the integration or any portion of it into a product or service offered to customers, subscribers, clients, or users for commercial advantage;
- white-labeling, reselling, sublicensing, or commercially hosting the integration; and
- using the integration to develop, test, market, or support a competing commercial integration.

PolyForm Noncommercial License 1.0.0:

<https://polyformproject.org/licenses/noncommercial/1.0.0>

Commercial licenses are available only under a separate written agreement.

This cross-platform integration plots GEX, Gamma, Vanna, and Charm exposure profiles on TradingView Desktop charts. It supports multi-pane layouts, multiple expirations, configurable Majors, futures conversion, and expanded Quant ticker coverage.

## Requirements

- TradingView Desktop for Linux, macOS, or Windows
- Node.js 22 or newer
- A gexbot API key

## Configure the API key

Create a TradingView gexbot API key from the [Connections page](https://www.gexbot.com/user/connections).

Configure the included example file from the package root:

1. Copy `docs/api-key.txt.example` to `api-key.txt`.
2. Open `api-key.txt`.
3. Replace `gexbot_tradingview_hashstringhere` with your TradingView API key.
4. Save the file.

Put only the API key on the first line. Do not use quotes or extra text.

On Linux and macOS, restrict access to the configured file:

```bash
chmod 600 api-key.txt
```

Restart the integration after changing the key.

`api-key.txt` is excluded by `.gitignore`. Do not include it in source control, screenshots, support bundles, or shared archives. A managed installation can override its location with `IOF_API_KEY_PATH`.

Settings are stored at:

- Linux: `${XDG_CONFIG_HOME:-$HOME/.config}/gexbot-tradingview-v1.0/config.json`
- macOS: `~/Library/Application Support/gexbot-tradingview-v1.0/config.json`
- Windows: `%LOCALAPPDATA%\gexbot-tradingview-v1.0\config.json`

`IOF_CONFIG_PATH` or `IOF_CONFIG_DIR` can override the settings location.

## Start

Linux:

```bash
./gexbot-launcher-linux.sh
```

macOS:

1. Open the package folder in Finder.
2. Double-click `gexbot-launcher-macos.command`.

Windows:

```text
gexbot-launcher-windows.bat
```

The launcher detects the installed TradingView Desktop application automatically. Linux supports common native, Snap, and Flatpak installations. macOS supports the standard Applications folders and Setapp. Windows supports the `TradingView.Desktop` Microsoft Store package.

If macOS blocks the launcher, Control-click `gexbot-launcher-macos.command` and select **Open**. Then select **Open** in the confirmation window.

## Linux sandbox fallback

If the Linux sandbox is unavailable, the launcher displays a security notice and asks before continuing with reduced sandboxing. It does not change system permissions or run as root.

Approval is saved at:

```text
${IOF_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gexbot-tradingview-v1.0}/allow-no-sandbox
```

Remove that file to restore the prompt. Reviewed unattended environments can use `GEXBOT_ALLOW_NO_SANDBOX=1`; `GEXBOT_ALLOW_NO_SANDBOX=0` declines the fallback.

## Shutdown

Close TradingView when finished. The companion shuts down automatically.

## Chart settings

Each chart pane has independent settings. Selecting a TradingView pane selects its matching settings pane, while selecting a settings pane does not change TradingView’s active pane. **Draw on this chart** is separate for Standard and Quant, so either profile set can be enabled or disabled without affecting the other. Profile drawings are automatically occluded beneath TradingView dialogs and popup menus.

### Standard

The Standard tab includes:

- Classic GEX Vol, Classic OI, State GEX, and State Gamma profiles;
- independent visibility and expiry settings for each profile;
- 0DTE, 1DTE, and Full expiries where available;
- alignment, origin, width, thickness, vertical pixel offset, colors, and prior dots;
- configurable Majors with visibility, color, label placement, line style, and thickness;
- optional intraday Major history as one-minute moving-average lines or raw scatter plots, with independent colors, draw styles, and line/dot thickness;
- selectable tickers and preset futures pairs with automatically populated conversion values; and
- manual additive and multiplicative futures conversion.

The ticker section is open by default. Profile, Majors, and manual conversion sections are collapsed by default. Standard performs an initial data pull when started, while recurring refreshes run only from 9:30 AM to 4:00 PM Eastern Time on weekdays.

### Quant

The Quant tab includes:

- explicit option expiration dates;
- Classic GEX Vol/OI and State GEX profiles;
- Delta, Gamma, Vanna, and Charm profiles;
- independent alignment, placement, width, thickness, vertical pixel offset, and positive/negative colors for every profile;
- configurable prior dots, dot size, and prior colors where supported;
- date-anchored or window-percentage placement for each profile;
- per-expiration reset controls and a control to copy one expiration’s complete profile setup to every expiration;
- a pane-level Quant profile template that carries copied settings across ticker changes;
- selectable tickers and preset futures pairs with automatically populated conversion values; and
- manual additive and multiplicative futures conversion.

The ticker section is open by default. Settings for an expiration appear after selecting its date and are collapsed by default. Each profile has its own collapsible section and Show toggle. A Quant-enabled API key is required for Quant profiles.

## Explicit-expiration defaults

On first use, the next five Friday expirations are enabled with:

- State Gamma selected;
- 50px profile width;
- right alignment; and
- expiration-date anchoring.

Expiration and profile selections can be staged before choosing **Apply changes**. Visual placement settings take effect immediately.

Date-anchored profiles outside the visible chart range remain hidden until that date is brought into view.

**Apply Settings To All Expiration Profiles** copies every profile setting from the selected expiration to all currently configured expirations without changing which expiration dates are enabled. It also saves those profiles as the pane’s Quant template, so inactive dates created later and expiration profiles loaded after switching tickers inherit the same settings.

## Compatibility and logs

If a TradingView update causes a compatibility problem, the settings panel displays an error.

Logs are stored at:

- Linux: `${XDG_STATE_HOME:-$HOME/.local/state}/gexbot-tradingview-v1.0/`
- macOS: `~/Library/Logs/gexbot-tradingview-v1.0/`
- Windows: `%LOCALAPPDATA%\gexbot-tradingview-v1.0\logs\`

## License

The [PolyForm Noncommercial License 1.0.0](docs/LICENSE) and the source-available license notice at the top of this README apply to this integration.
