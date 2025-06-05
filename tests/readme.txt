Video: https://discord.com/channels/955572167662260295/1062092338698145812/1338591521401733192

# Playwright Testing

### Goal
E2E testing for the main app.
Catch potential issues when changing code, or evaluate edge cases.

### Anti-Goal
For this to be a frustrating pain-in-the-ass time vampire.
It's better to have 1 decent test than try to do 10 perfect ones and give up because it's too time consuming.

### What to Do

- Write tests for common user flows (fill a form, click a button, get a result)
- Handle what-if scenarios (errors, browsers, etc)
- A good rule of thumb is: if it's been reported as a bug, we should have a test in place for it (and things like it)

### What Not to Do

- Write "1==1" tests (dopamine hit, but pointless)
- Mandate coverage percentages (leads to annoyance and features not being done)

---

### How

Testing is intended to work on local development (docker) for consistency with users/data and easy tear down.

1) Run local services (`make init` or devcontainers)
2) Create a file in the `tests/` directory, or use an existing one. Doesn't really matter. Open to directory structure, so something like `tests/generator/gen-queue.spec.ts` would be reasonable.
3) Start writing tests.
    (a) can be done by hand if you know what you're looking to do
    (b) easier approach: `npm run test:gen -- --load-storage tests/auth/{user}.json --viewport-size 1920,1080 http://localhost:3000/{url}`
        - This allows you to create tests by interacting with the page and picking locators
    (c) we'll need better locators, especially for icons. add `data-testid=` to the places you need them (they'll be stripped from production)
    (d) use the various authed users to test different scenarios (mod, full access, muted, etc)
    (e) feel free to mock responses from any of the APIs, but in general it's best to only do this for external services
4) Run with either `npm run test` or `npm run test:ui` to do it interactively with screenshots
5) If you need to reset the db after each test, you can either:
    (a) clean up the mutations as part of the test (delete an object you just made)
    (b) `make boostrap-db` to reset the whole database back to normal
6) We'll eventually set up the github action to run this before a deploy

### Test Failures

There are 4 types of test failures:

1) A bad test (always fail)
    - these might have bad selectors or inaccurate logic
    - **solution**: fix them
2) A flaky test (sometimes fail)
    - frustrating tests which seem to pass most of the time, but not always
        - this is usually a result of race conditions, mismatched timing, or not properly awaiting events like animations
    - **solution**: narrow down which part of the test fails, and catch the flaky issue
3) Intended code change
    - we might have changed the verbiage on a button, which makes certain locators no longer work
        - this is fine, although locators should try to be as agnostic as possible
    - alternatively, we might have simply changed the business logic
    - **solution**: in either case, simply update the test itself
4) Unintended code change
    - you've changed something in the app, and a test breaks due to the introduction of a bug
        - this is the major reason we have tests
    - **solution**: leave the tests alone, they're doing their job. fix the code.
