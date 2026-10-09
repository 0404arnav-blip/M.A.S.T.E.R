# Google Docs, Sheets & Slides for M.A.S.T.E.R (one-time setup, ~10 minutes)

With this on, you can say *"make a Google Doc about the French Revolution"*, *"put my
expenses in a Google Sheet"* or *"make a Google Slides deck on the water cycle"* and M.A.S.T.E.R
creates it **in your own Google Drive** and gives you an **Open** button. Nothing is downloaded.
It can also add to a doc, sheet or deck it made earlier.

**What it is allowed to do:** only the narrow `drive.file` permission - it can create files and
edit the ones *it* created. It cannot see, open, change or delete anything else in your Drive.

Google requires every app that touches your Drive to have its own "client". Creating one is free
and you do it once, in your own Google account. Nothing here is shared with anyone else, and no
credentials are stored in this repository.

> The wording of Google's console changes now and then. The names below match Google's current
> documentation; if a menu looks slightly different, look for the same word.

## 1. Make a project

1. Go to <https://console.cloud.google.com> and sign in with the Google account where you want
   your documents to appear.
2. At the top, open the project picker, choose **New project**, call it `MASTER`, and **Create**.
   Make sure it is the selected project.

## 2. Switch on the three APIs

1. Menu (☰) → **APIs & Services** → **Library**.
2. Search **Google Docs API** → open it → **Enable**.
3. Back in the Library, search **Google Sheets API** → **Enable**.
4. Back in the Library, search **Google Slides API** → **Enable**.

(You only need to enable the ones you want to use. The Drive API is *not* needed.)

(The Drive API is *not* needed.)

## 3. Set up the consent screen

1. Menu → **Google Auth platform** → **Branding**. If it says it isn't configured yet, click
   **Get Started**.
2. App name: `M.A.S.T.E.R`, and pick your email as the support email → **Next**.
3. Audience: choose **External** → **Next**.
4. Contact information: your email → **Next**. Tick the user-data-policy box → **Continue** →
   **Create**.
5. Click **Audience** → under **Test users** click **Add users** → add **your own Google
   account's email** (and anyone else who will use it) → **Save**.
6. Click **Data Access** → **Add or remove scopes** → find
   `.../auth/drive.file` ("See, edit, create and delete only the specific Google Drive files you
   use with this app") → tick it → **Update** → **Save**.

## 4. Create the client

1. Menu → **Google Auth platform** → **Clients** → **Create client**.
2. **Application type: TVs and Limited Input devices.** (It must be this type - it is the one that
   lets a phone sign in with a short code.)
3. Name it `MASTER phone` → **Create**.
4. Copy the **Client ID** and the **Client secret** that Google shows you.

## 5. Give them to M.A.S.T.E.R

1. Open M.A.S.T.E.R on your phone → the gear (settings) → **Google Docs & Sheets**.
2. Paste the **Client ID** and **Client secret** → **Save**.
3. Say or type: *"Make a Google Doc called Trip plan with a day-by-day list."*
4. The first time, M.A.S.T.E.R shows a short code and a button. Tap the button (it opens
   google.com/device), enter the code, choose your Google account and approve. M.A.S.T.E.R carries on
   by itself and gives you an **Open in Google Docs** button.

You can also press **Connect now** in settings to do the sign-in without asking for a document.

## Things to know

- **Testing mode lasts 7 days.** While the project's status is "Testing", Google makes the saved
  sign-in expire after 7 days (Google's documentation: "a refresh token expiring in 7 days").
  You will simply be shown a new code the next time (about 30 seconds). To stop that, open
  **Google Auth platform → Audience → Publish app**. M.A.S.T.E.R only asks for the
  non-sensitive `drive.file` permission, which should not need Google's review, but check
  Google's prompts when you publish.
- **Where files go:** the top level of *My Drive*. Search for the title in the Drive app.
- **Tables in a Doc:** a Google Doc made by M.A.S.T.E.R is text, headings, bullets and bold; for a
  table ask for a **Sheet**.
- **Slides:** each slide is a title, bullet points and, if you like, a picture (*"...with a picture
  of the Bastille"*). Pictures come from Wikimedia Commons and are credited on the slide; Google
  fetches them itself, so nothing is downloaded to your phone. A deck is capped at 40 slides, and
  the first slide is a title slide with the date. The look is your Google theme's default.
- **"Add to my doc / sheet / deck"** only works on files M.A.S.T.E.R created. Say *"list my
  Google files"* to see them.
- **Errors you may see:**
  - *"not switched on for your project"* → step 2 (it gives you the link; wait a minute after
    pressing Enable).
  - *"Client ID / secret"* → re-copy both values, and check the client type in step 4.
  - *"add your account under Test users"* → step 3.5.
- **Keeping the values safe:** they are stored only on your phone and sent only to Google. For this
  client type Google does not treat the secret as confidential, but don't post it publicly; if it
  leaks, delete the client in the console and make a new one.
- **Using the USB-stick file:** sign-in works there too (the code method needs no web address),
  but that build saves nothing on the phone, so you re-enter the code each time you open it.
  `make_usb.py --google-file` can bake the two values into a stick of your own.
- **Whose account:** each person signs in with *their own* Google account, so documents land in
  their Drive. Several people can share one client; they need to be listed as Test users (or
  you publish the app) before Google lets them in.
