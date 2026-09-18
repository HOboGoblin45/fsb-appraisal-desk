@echo off
cd /d C:\Users\ccres\fsb-appraisal-desk
echo.
echo  FSB Appraisal Desk: text-message (Twilio) secrets for the production Worker.
echo  Paste each value when asked and press Enter. Nothing you type here is shown to Claude.
echo.
echo  1 of 3: Account SID (starts with AC, shown on the Twilio console home page)
call npx wrangler secret put TWILIO_ACCOUNT_SID
echo.
echo  2 of 3: Auth Token (click the eye icon next to Auth Token on the Twilio console home page)
call npx wrangler secret put TWILIO_AUTH_TOKEN
echo.
echo  3 of 3: the Twilio phone number in E.164 form, for example +13095550100
echo  (if you set up a Messaging Service instead, close this window and run: npx wrangler secret put TWILIO_MESSAGING_SERVICE_SID)
call npx wrangler secret put TWILIO_FROM
echo.
echo  Done. The portal picks the secrets up immediately; no redeploy needed.
pause
