# LinkedIn Helper Pro

LinkedIn Helper Pro is a Chrome extension for finding people on LinkedIn, generating likely work email addresses, and running personalized outreach from one interface.

It supports LinkedIn messages and connection notes, Gmail-based email sending, reusable templates, bulk workflows, duplicate-email prevention, rate limits, activity tracking, and CSV import/export.

> **Important:** LinkedIn and Gmail can change their pages and internal APIs without notice. This extension relies on both DOM automation and LinkedIn's internal Voyager endpoints, so some features may occasionally require maintenance.

## Features

- Search LinkedIn people results across multiple pages
- Read contact emails when they are visible on LinkedIn
- Generate likely company email addresses from known or custom formats
- Export discovered profiles to CSV
- Create reusable LinkedIn message and email templates
- Personalize templates with first name, last name, full name, and company
- Send LinkedIn messages and connection requests
- Compose and send Gmail messages in background tabs
- Import outreach recipients from CSV
- Filter by connection status and exclude selected companies
- Run bulk outreach with pause, stop, delay, and dry-run controls
- Prevent duplicate emails by checking the Gmail Sent folder
- Optionally discover emails through Apollo.io
- Apply hourly and daily sending limits
- Track activity and seven-day outreach statistics
- Store settings, templates, cache, and history locally
- Use light, dark, or system theme

## Requirements

- Google Chrome or another Chromium browser with Manifest V3 support
- An active LinkedIn session
- An active Gmail session for email sending
- A Google OAuth client for Gmail duplicate checking
- An Apollo.io API key only if Apollo email discovery is enabled

No package installation or build step is required.

## Install

1. Download or clone this directory.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this project directory.
6. Open LinkedIn and refresh the page.

The extension can be opened from the browser toolbar or from the floating **LH Pro** button injected into LinkedIn pages.

## Usage

### Scrape Profiles

1. Sign in to LinkedIn and keep a LinkedIn tab open.
2. Open the extension and select **Scrape**.
3. Enter a search such as `engineering manager google`.
4. Choose the number of result pages to scan.
5. Click **Search**.
6. Export the results to `linkedin_profiles.csv`.

When LinkedIn exposes a contact email, the extension labels it as `real`. Otherwise, it generates a likely address from the person's name, company, and configured email format.

The generated CSV contains:

```text
First Name,Last Name,Company,Email,Email Type,Alt Formats
```

Generated addresses are guesses and should be verified before use.

### Configure Email Formats

Open **Scrape > Formats** to add a company-specific pattern. Supported patterns are:

| Pattern | Example |
| --- | --- |
| `first.last` | `jane.doe@example.com` |
| `flast` | `jdoe@example.com` |
| `firstlast` | `janedoe@example.com` |
| `first` | `jane@example.com` |
| `f.last` | `j.doe@example.com` |
| `first_last` | `jane_doe@example.com` |

Built-in company formats are defined in `company-formats.js`. Custom overrides are stored in `chrome.storage.local`.

### Send Outreach

1. Open the **Outreach** tab.
2. Create a message or email template.
3. Add replacement keywords such as `{name}` or `{company}`.
4. Search LinkedIn or import a CSV.
5. Select individual recipients or open the bulk selection dialog.
6. Preview the personalized content before sending.

Enable **Dry run** while testing LinkedIn message workflows. Bulk sends run sequentially using the delay configured under **Settings**.

### Import CSV

CSV import recognizes common column names for:

- First name
- Last name
- Company
- Email

For the most reliable import, use columns named `First Name`, `Last Name`, `Company`, and `Email`.
LinkedIn messaging is unavailable for CSV-only recipients because the importer does not include LinkedIn profile identifiers.

## Gmail Authorization

The Gmail integration requests the read-only scope:

```text
https://www.googleapis.com/auth/gmail.readonly
```

This access is used to inspect the Sent folder for duplicate prevention and sent-today statistics. Actual email delivery is performed by opening Gmail's compose interface and clicking its Send button.

To use your own OAuth client:

1. Create a project in the [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the Gmail API.
3. Configure the OAuth consent screen.
4. Create a **Web application** OAuth client.
5. Copy the extension ID shown on `chrome://extensions`.
6. Add this redirect URI to the OAuth client:

   ```text
   https://EXTENSION_ID.chromiumapp.org/
   ```

7. Replace `oauth2.client_id` in `manifest.json` with your client ID.
8. Reload the extension.
9. Open **Outreach > Email > Gmail & Cache** and click **Authorize Gmail**.

If authorization fails, confirm that the client type and redirect URI match the values expected by `chrome.identity.getRedirectURL()`.

## Apollo Email Discovery

Apollo lookup is optional. Enable it under **Settings > Email Discovery**, enter an API key, and use **Find Emails** from the bulk selection dialog.

Discovery runs in this order:

1. LinkedIn Contact Info
2. Apollo.io
3. Pattern-based email guess

Apollo plans may return masked addresses or require credits. Cross-origin Apollo requests also require `https://api.apollo.io/*` in `host_permissions` if it is not already present in your local `manifest.json`.

## Rate Limits and Duplicate Prevention

The extension can enforce combined hourly and daily limits across email, LinkedIn messages, and connection requests. Configure conservative values under **Settings > Rate Limits**.

Duplicate-email prevention builds a local cache from Gmail's Sent folder. You can skip recipients contacted within a chosen number of days or permanently skip every previously emailed address.

These controls reduce accidental over-sending, but they do not guarantee compliance with LinkedIn, Google, or email-provider policies.

## Data and Privacy

Templates, settings, cached recipient addresses, activity history, and send statistics are stored in `chrome.storage.local`.

Data is sent only as required by enabled actions:

- LinkedIn searches and outreach communicate with LinkedIn.
- Gmail authorization and duplicate checks communicate with Google APIs.
- Email sending interacts with the Gmail web interface.
- Apollo discovery sends recipient details to Apollo.io when enabled.

Use **Settings > Export all data** to download local extension data, or **Reset everything** to remove it.

## Project Structure

```text
.
├── manifest.json        # Extension metadata, permissions, and entry points
├── popup.html           # Popup and embedded panel interface
├── popup.js             # UI, templates, search, bulk sending, and settings
├── content.js           # LinkedIn API access, DOM automation, and launcher
└── company-formats.js   # Built-in company email-format database
```

## Development

There is no compilation step. Edit the source files, then reload the extension from `chrome://extensions` and refresh the LinkedIn page.

Useful debugging locations:

- Popup: right-click the extension popup and select **Inspect**
- Service worker: open `chrome://extensions`, find the extension, and click **Service worker**
- Content script: open LinkedIn DevTools and inspect the page console

Set `DEBUG = true` near the top of `content.js` to enable content-script logs.

## Troubleshooting

### The extension cannot reach LinkedIn

Confirm that you are signed in, reload the LinkedIn tab, and reopen the extension. Content scripts are installed when the page loads.

### Search returns no people

LinkedIn may have changed its Voyager response structure or query identifiers. Check the LinkedIn DevTools Network and Console panels for failed requests.

### LinkedIn messaging or connection requests fail

LinkedIn frequently changes button labels and page markup. Test with dry-run mode first and inspect `content.js` selectors if the workflow stops finding controls.

### Gmail authorization fails

Verify the OAuth client ID, consent-screen configuration, Gmail API status, extension ID, and `chromiumapp.org` redirect URI.

### Gmail opens but does not send

Make sure Gmail is signed in as the expected account and fully loaded. The automation waits for Gmail's Send control and a sent confirmation before closing the tab.

## Responsible Use

Use this extension only for lawful, relevant, and consent-aware outreach. Respect LinkedIn's User Agreement, Google's policies, applicable anti-spam laws, recipient preferences, and account limits. You are responsible for reviewing generated addresses and every message sent through the extension.
