# Putting Second Tap on AWS, step by step

Total time: about 45 minutes the first time. You do not need to install anything
on your laptop for the AWS part; it all happens in the browser.

**Honest note:** the app was tested on a laptop, the AWS template was checked and
built with the AWS SAM tool, the database code was run against a local DynamoDB
emulator, and the AI reader was run against a stand-in for Amazon Bedrock. It has
not yet been deployed to a real AWS account. If a step below behaves differently
from what is written, copy the error message and ask for help.

---

## Part A. Create your AWS account (15 minutes)

You need: an email address, a phone that can receive an OTP, and a debit card
(RuPay works). The hackathon page says the card check costs about ₹2.

1. Go to https://aws.amazon.com/free and choose **Create an AWS Account**.
2. Enter your email and an account name (for example `second-tap`). AWS emails
   you a code; enter it.
3. Set a strong password. This is your **root** login. Keep it safe.
4. When asked to pick a plan, choose the **Free** plan. On the Free plan you are
   not charged. It lasts 6 months or until your credits run out, whichever is first,
   and new accounts get $100 in credits at sign-up.
5. Contact information: choose **Personal**, then fill in your name and address.
6. Payment: enter your debit card. This is only to verify you.
7. Confirm your phone number with the OTP.
8. Support plan: choose **Basic support (Free)**.
9. Sign in at https://console.aws.amazon.com as **Root user** with your email.

Two things to do straight after signing in:

10. **Turn on MFA** (a second login step, so nobody can take over the account).
    Click your account name at the top right, then **Security credentials**, then
    **Assign MFA device**, and follow the steps with an authenticator app on your phone.
11. **Pick the Mumbai region.** At the top right of the console there is a region
    name. Click it and choose **Asia Pacific (Mumbai) ap-south-1**. Stay in this
    region for everything below.

The sign-up screens change from time to time, so the wording may differ slightly.

---

## Part B. Put the code on GitHub (10 minutes)

You need a public GitHub repository for your submission anyway.

1. On https://github.com choose **New repository**. Name it `second-tap`, make it
   **Public**, and do not add a README (the project already has one).
2. On your laptop, open a terminal in the `second-tap` folder and run:

   ```bash
   git init
   git add .
   git commit -m "Second Tap: first working version"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/second-tap.git
   git push -u origin main
   ```

Commit again each time you change something. The rules say a repository whose
history does not match the event dates is disqualified, so real commits during
the event are what you want.

---

## Part C. Deploy (10 minutes)

1. In the AWS console, click the **CloudShell** icon in the top bar. It looks like
   `>_`. A terminal opens at the bottom of the page. It already has the tools you
   need (git and the AWS SAM tool) and is already signed in as you.
2. Copy your code into it:

   ```bash
   git clone https://github.com/YOUR-USERNAME/second-tap.git
   cd second-tap
   ```

3. Build and deploy:

   ```bash
   sam build
   sam deploy
   ```

   `sam build` downloads the AWS libraries the app uses, so it takes a minute.
   `sam deploy` takes two or three more. It creates the Lambda function, the API
   Gateway address, the DynamoDB table and the S3 bucket described in
   `template.yaml`, and gives the function permission to use Amazon Bedrock.

4. When it finishes it prints an **Outputs** table. Copy the value next to
   **SiteUrl**. It looks like `https://abc123.execute-api.ap-south-1.amazonaws.com`.
   That is your live website.
5. Load the sample listings (replace the address with yours):

   ```bash
   curl -X POST https://abc123.execute-api.ap-south-1.amazonaws.com/api/seed
   ```

   It should answer `{"added":10,"requests":3}`.
6. Open the SiteUrl on your phone and your laptop. Search from **Jakkur** to see matches.

### Check the AI report reader

The reader uses Amazon Bedrock. Nothing needs switching on by hand, but check it
works in your account. In CloudShell run:

```bash
aws bedrock-runtime converse --region ap-south-1 \
  --model-id global.amazon.nova-2-lite-v1:0 \
  --messages '[{"role":"user","content":[{"text":"Reply with the word OK"}]}]'
```

- **If you see a reply containing `OK`**, the reader will work. On the live site
  open **List spare water**, upload a real lab report, and the numbers should fill
  in within a few seconds.
- **If you see an error**, open **Amazon Bedrock** in the console, go to the chat
  playground, pick an **Amazon Nova** model and send one message. Then run the
  command again. (The console home lists "Use a foundation model in the Amazon
  Bedrock playground" as an activity that earns $20 in credits.)
- **If it still fails**, the site keeps working: the report is attached and the
  seller types the numbers. Send the error message and ask for help.

### To update the site after changing code

Push your change to GitHub, then in CloudShell:

```bash
cd second-tap
git pull
sam build
sam deploy
```

### If something goes wrong

| What you see | What to do |
| --- | --- |
| CloudShell will not open, or says it is not available | Install the [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) and [SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) on your laptop, run `aws configure`, then run the same `sam build` and `sam deploy` there. |
| `sam deploy` fails part-way | Read the first line that says `CREATE_FAILED`; it names the resource and the reason. Then run `sam delete` and deploy again. |
| The site opens but shows "Could not load the page settings" | In the console open **CloudWatch**, then **Log groups**, and open the group with `AppFunction` in its name to see the error. |
| Uploading a report says "Type the numbers from it below" | The AI reader is not available. See "Check the AI report reader" above. Typing still works. |
| The lab report upload fails | Check you are opening the site with the exact SiteUrl (https), and that the file is a PDF, JPG or PNG under 5 MB. |

---

## Part D. What to show in your demo video

The rules say the video must **show** AWS, not only mention it. After a search and
one new listing on the live site, switch to the AWS console and show, for a few
seconds each:

1. **DynamoDB**, then **Explore items**, then your table: the listing you just
   published is there, along with the request and the AI's reading of the report.
2. **S3**, then your bucket, then the `reports/` folder: the lab report you uploaded.
3. **Lambda**, then your function: the code and the **Monitor** tab with recent calls.
4. **API Gateway**: the address matches the one in your browser.

On the live site itself, show the AI filling in the form from an uploaded lab
report. That is Amazon Bedrock at work, and it is the easiest AWS moment for a
judge to understand.

---

## Part E. Cost, and cleaning up

At hackathon traffic Lambda, API Gateway, DynamoDB and S3 use a tiny fraction of
the free allowances. Amazon Bedrock is paid for from your credits each time it
reads a report; the cost per report is very small, and the app reads at most 200
reports a day. On the Free plan you are not charged money. The API is also
rate-limited in the template.

To switch the AI reader off completely, deploy with:

```bash
sam deploy --parameter-overrides ReportReaderModels=""
```

When the hackathon results are out and you no longer need the site, remove
everything (replace the bucket name with the **BucketName** from the Outputs):

```bash
aws s3 rm s3://YOUR-BUCKET-NAME --recursive
cd second-tap
sam delete
```
