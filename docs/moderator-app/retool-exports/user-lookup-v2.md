# user-lookup-v2.json

queries: 170   components: 433
resources: REST-WithoutResource, Clickhouse, Replicated_Read_Prod, Clickhouse - protection disabled, BuzzTemp, retool_db, Prod, JavascriptQuery, MongoDB, Notifications DB

## component types (scale signal; the structure itself is below)
  TextWidget2: 119
  ButtonWidget2: 85
  TableWidget2: 46
  TextInputWidget2: 29
  ContainerWidget2: 27
  Function: 22
  SelectWidget2: 22
  ModalFrameWidget: 11
  TextAreaWidget: 10
  ModalWidget: 7
  CheckboxWidget2: 7
  TabsWidget2: 7
  IconWidget: 6
  NumberInputWidget: 5
  State: 3
  DividerWidget: 3
  DateTimeWidget: 3
  ImageWidget2: 3
  Frame: 2
  FormWidget2: 2
  NavigationWidget2: 2
  SwitchWidget2: 2
  JSONEditorWidget: 2
  AppStyles: 1
  SegmentedControlWidget: 1
  AlertWidget: 1
  TimeWidget: 1
  RadioGroupWidget2: 1
  SplitButtonWidget: 1
  SidebarFrameWidget: 1
  AvatarWidget: 1

## tabs & option sets — READ THESE, they are functionality
  Tab labels are the app's table of contents; dropdown options are canned workflows that
  exist in no query. A tab you did not port is a capability you did not port.

### select12   [SelectWidget2]
    - Actioned
    - Unactioned
    - Pending

### select13   [SelectWidget2]
    - Admin Attention
    - NSFW
    - TOS Violation
    - Ownership
    - Claim

### select22   [SelectWidget2]
    - True
    - False
    - 1
    - 0

### select23   [SelectWidget2]
    - True
    - False
    - 1
    - 0

### select24   [SelectWidget2]
    - True
    - False
    - 1
    - 0

### select25   [SelectWidget2]
    - 1
    - 2
    - 3
    - 4
    - 5

### segmentedControl1   [SegmentedControlWidget]
    - Model Comments
    - Other Comments
    - Comment
    - CommentV2

### presetMutes   [SelectWidget2]
    - 6 Hours
    - 12 Hours
    - 24 Hours
    - 48 Hours
    - 72 Hours
    - 1 Week
    - 6
    - 12
    - 24
    - 48
    - 72
    - 168

### socialTypeInsert   [SelectWidget2]
    - Social
    - Sponsorship

### tabbedContainer8   [ContainerWidget2]
    - Submitted Reviews
    - Received Reviews

### tabs7   [TabsWidget2]
    - Tab 1
    - Tab 2
    - Tab 3

### select41   [SelectWidget2]
    - 1
    - 2
    - 3
    - 4
    - 5

### tabbedContainer9   [ContainerWidget2]
    - Bounties
    - Bounty Entries

### tabs8   [TabsWidget2]
    - Tab 1
    - Tab 2
    - Tab 3

### tabbedContainer10   [ContainerWidget2]
    - Reports Received
    - Reports Submitted

### tabs9   [TabsWidget2]
    - Tab 1
    - Tab 2
    - Tab 3

### tabbedContainer12   [ContainerWidget2]
    - Buzz Transaction

### tabs11   [TabsWidget2]
    - Tab 1
    - Tab 2
    - Tab 3

### buzzSendEntityType   [SelectWidget2]
    - Collection
    - Image
    - Model

### buzzSendAction   [SelectWidget2]
    - Send Buzz to User
    - Deduct Buzz from User
    - send
    - deduct

### tabbedContainer13   [ContainerWidget2]
    - Reactions Given

### tabs12   [TabsWidget2]
    - Tab 1
    - Tab 2
    - Tab 3

### buzzType   [SelectWidget2]
    - Yellow Buzz
    - Blue Buzz
    - Green Buzz
    - User
    - generation
    - green

### tabbedContainer14   [ContainerWidget2]
    - 1. Find Account
    - 2. Remove an old paddleCustomerId account
    - 3. Link Paddle Account

### tabs13   [TabsWidget2]
    - Tab 1
    - Tab 2
    - Tab 3

### splitButton1   [SplitButtonWidget]
    - Stripe Chargeback Retrieval
    - Stripe Refund
    - 1st Place Stream Bingo
    - 2nd Place Stream Bingo
    - 3rd Place Stream Bingo
    - Action 4
    - Action 5

### navigation1   [NavigationWidget2]
    - Basic User Information
    - Socials & Bio
    - Content Overview
    - Bulk Image Manager
    - Buzz
    - Prompt Audit
    - Cosmetic Shop
    - Image Generation
    - LoRA Training
    - Bounties
    - Comments
    - Leaderboard
    - Reports
    - Reviews
    - Reactions
    - Moderation Activity
    - Chat (DMs)
    - Civitai Score

### navigation3   [NavigationWidget2]
    - Admin 
    - Notifications
    - Timed Mutes

### MainContentContainer   [ContainerWidget2]
    - basic

### tabs14   [TabsWidget2]
    - Tab 1
    - Tab 2
    - Tab 3

## layout — panes, containers and modals
  Retool's shape. A container with several PANES is a tab group: port it as SUB-PAGES,
  one route per pane, not as one long page — a moderator who had tabs and now scrolls
  reports the tool as broken. A modal is a dialog, not an inlined panel.
  "only visible when" is a role/state gate that appears in NO query — port it too.

### container15   [ContainerWidget2] — 1 pane(s)  (inside MainContentContainer)
  - "View 1"  [b70f2]
      text120 [TextWidget2]
      text122 [TextWidget2]
      text121 [TextWidget2]
      text123 [TextWidget2]
      containerTitle20 [TextWidget2]   (not in a pane)

### container17   [ContainerWidget2] — 1 pane(s)  (inside MainContentContainer)
  - "View 1"  [b70f2]
      text82 [TextWidget2]
      text93 [TextWidget2]
      text171 [TextWidget2]
      text81 [TextWidget2]
      text91 [TextWidget2]
      text83 [TextWidget2]
      text84 [TextWidget2]
      text85 [TextWidget2]
      text94 [TextWidget2]
      text87 [TextWidget2]
      text92 [TextWidget2]
      text89 [TextWidget2]
      text90 [TextWidget2]
      text88 [TextWidget2]
      text86 [TextWidget2]
      divider3 [DividerWidget]
      text79 [TextWidget2]
      text156 [TextWidget2]
      text158 [TextWidget2]
      text164 [TextWidget2]
      text154 [TextWidget2]
      text163 [TextWidget2]
      text80 [TextWidget2]
      text155 [TextWidget2]
      text157 [TextWidget2]
      text159 [TextWidget2]
      containerTitle22 [TextWidget2]   (not in a pane)

### container18   [ContainerWidget2] — 1 pane(s)  (inside MainContentContainer)
  - "View 1"  [b70f2]
      text153 [TextWidget2]
      text126 [TextWidget2]
      text127 [TextWidget2]
      text132 [TextWidget2]
      text128 [TextWidget2]
      text134 [TextWidget2]
      text125 [TextWidget2]
      text129 [TextWidget2]
      text130 [TextWidget2]
      text133 [TextWidget2]
      text131 [TextWidget2]
      text135 [TextWidget2]
      containerTitle23 [TextWidget2]   (not in a pane)

### container19   [ContainerWidget2] — 1 pane(s)  (inside MainContentContainer)
  - "View 1"  [b70f2]
      text160 [TextWidget2]
      text161 [TextWidget2]
      text162 [TextWidget2]
      text137 [TextWidget2]
      text139 [TextWidget2]
      text141 [TextWidget2]
      containerTitle24 [TextWidget2]   (not in a pane)

### container22   [ContainerWidget2] — 1 pane(s)  (inside MainContentContainer)
  - "View 1"  [f37a7]
      socialTypeInsert [SelectWidget2] "Link Type"
      socialURLInsert [TextInputWidget2] "URL"
      button37 [ButtonWidget2] "Remove Selected"
      button38 [ButtonWidget2] "Add New"
      containerTitle29 [TextWidget2]   (not in a pane)

### container23   [ContainerWidget2] — 1 pane(s)  (inside MainContentContainer)
  - "View 1"  [e6a13]
      icon1 [IconWidget]
      text181 [TextWidget2]
      text182 [TextWidget2]
      containerTitle30 [TextWidget2]   (not in a pane)

### container24   [ContainerWidget2] — 1 pane(s)  (inside MainContentContainer)
  - "View 1"  [e6a13]
      icon3 [IconWidget]
      text183 [TextWidget2]
      text184 [TextWidget2]
      containerTitle31 [TextWidget2]   (not in a pane)

### container25   [ContainerWidget2] — 1 pane(s)  (inside MainContentContainer)
  - "View 1"  [e6a13]
      icon2 [IconWidget]
      text185 [TextWidget2]
      text186 [TextWidget2]
      containerTitle32 [TextWidget2]   (not in a pane)

### container26   [ContainerWidget2] — 1 pane(s)  (inside MainContentContainer)
  - "View 1"  [e6a13]
      icon4 [IconWidget]
      text187 [TextWidget2]
      text188 [TextWidget2]
      containerTitle33 [TextWidget2]   (not in a pane)

### container27   [ContainerWidget2] — 1 pane(s)  (inside MainContentContainer)
  - "View 1"  [e6a13]
      icon5 [IconWidget]
      text189 [TextWidget2]
      text190 [TextWidget2]
      containerTitle34 [TextWidget2]   (not in a pane)

### container28   [ContainerWidget2] — 1 pane(s)  (inside MainContentContainer)
  - "View 1"  [e6a13]
      icon6 [IconWidget]
      text191 [TextWidget2]
      text192 [TextWidget2]
      containerTitle35 [TextWidget2]   (not in a pane)

### tabbedContainer8   [ContainerWidget2] — 2 pane(s), tab bar tabs7  (inside MainContentContainer)
  - "Submitted Reviews"  [64ee2]
      button115 [ButtonWidget2] "Include"
      review_conf_window [ModalWidget]
      button114 [ButtonWidget2] "Exclude"
      select24 [SelectWidget2] "TOS Violation?"
      select23 [SelectWidget2] "NSFW?"
      select22 [SelectWidget2] "Excluded?"
      select25 [SelectWidget2] "Review Rating"
      textInput1 [TextInputWidget2] "Search Review Content"
      reviews [TableWidget2]
  - "Received Reviews"  [65c4d]
      select41 [SelectWidget2] "Review Rating"
      table41 [TableWidget2]
      tabs7 [TabsWidget2]   (not in a pane)

### tabbedContainer9   [ContainerWidget2] — 2 pane(s), tab bar tabs8  (inside MainContentContainer)
  - "Bounties"  [b6dd8]
      select29 [SelectWidget2] "Type"
      select30 [SelectWidget2] "Complete"
      textInput8 [TextInputWidget2] "Name Contains"
      textInput9 [TextInputWidget2] "Description Contains"
      button109 [ButtonWidget2] "Check Bounties"
      table26 [TableWidget2]
  - "Bounty Entries"  [94c47]
      table42 [TableWidget2]
      tabs8 [TabsWidget2]   (not in a pane)

### tabbedContainer10   [ContainerWidget2] — 2 pane(s), tab bar tabs9  (inside MainContentContainer)
  - "Reports Received"  [2b88f]
      select46 [SelectWidget2] "Status"
      button57 [ButtonWidget2] "Check Reports"
      table43 [TableWidget2]
  - "Reports Submitted"  [b6dd8]
      select47 [SelectWidget2]
      select13 [SelectWidget2]
      select12 [SelectWidget2]
      table12 [TableWidget2]
      tabs9 [TabsWidget2]   (not in a pane)

### group1   [ContainerWidget2] — 1 pane(s)
  - "View 1"  [79439]
      textArea3 [TextAreaWidget] "Notification Message"
      textArea2 [TextAreaWidget] "Strike Reason"
      button69 [ButtonWidget2] "Strike User"
      button67 [ButtonWidget2] "Send Notification"

### tabbedContainer12   [ContainerWidget2] — 2 pane(s), tab bar tabs11  (inside MainContentContainer)
  - "View Buzz"  [e22e4]
      button75 [ButtonWidget2] "Check Buzz"
      buzzDateTime [DateTimeWidget] "After date"
      divider6 [DividerWidget]
      text195 [TextWidget2]
      text196 [TextWidget2]
      select37 [SelectWidget2] "Payment Type"
      select35 [SelectWidget2] "Receipt Type"
      textInput10 [TextInputWidget2] "Description"
      table23 [TableWidget2]
      table24 [TableWidget2]
      table54 [TableWidget2]
      table53 [TableWidget2]
  - "Buzz Transaction"  [9e62d]   — only visible when NOT: {{!(current_user.groups.some(i => i.name === "Senior Mod"))}}
      buzzSendAction [SelectWidget2] "Action"
      buzzSendType [SelectWidget2] "Reason"
      container30 [ContainerWidget2]
      container29 [ContainerWidget2]
      buzzType [SelectWidget2] "Type of Buzz"
      buzzSendAmount [NumberInputWidget] "Amount"
      buzzSendDescription [TextInputWidget2] "Description"
      buzzSendDetails [ContainerWidget2]
      button79 [ButtonWidget2] "{{buzzSendAction.value === 'deduct' ? 'Deduct' : 'Send' }} B"
      text214 [TextWidget2]   (not in a pane)
      text213 [TextWidget2]   (not in a pane)
      text220 [TextWidget2]   (not in a pane)
      text219 [TextWidget2]   (not in a pane)
      text230 [TextWidget2]   (not in a pane)
      text231 [TextWidget2]   (not in a pane)
      tabs11 [TabsWidget2]   (not in a pane)

### buzzSendDetails   [ContainerWidget2] — 1 pane(s)  (inside tabbedContainer12)
  - "View 1"  [18593]
      buzzSendEntityType [SelectWidget2] "EntityType"
      buzzSendEntityId [NumberInputWidget] "EntityId"

### tabbedContainer13   [ContainerWidget2] — 1 pane(s), tab bar tabs12  (inside MainContentContainer)
  - "Reactions Given"  [698e0]
      button82 [ButtonWidget2] "Check Reactions"
      table59 [TableWidget2]
      table60 [TableWidget2]
      tabs12 [TabsWidget2]   (not in a pane)

### tabbedContainer14   [ContainerWidget2] — 3 pane(s), tab bar tabs13
  - "1. Find Account"  [1615e]
      textInput15 [TextInputWidget2] "Enter Paddle Customer Id"
      table71 [TableWidget2]
  - "2. Remove an old paddleCustomerId account"  [7db07]
      textInput14 [TextInputWidget2] "Enter User Id"
      button95 [ButtonWidget2] "Remove Link"
  - "3. Link Paddle Account"  [5ce8c]
      textInput12 [TextInputWidget2] "Enter Paddle Customer Id"
      button90 [ButtonWidget2] "Update Link on {{ userIdVar.value }}"
      tabs13 [TabsWidget2]   (not in a pane)

### MainContentContainer   [ContainerWidget2] — 21 pane(s), tab bar tabs14
  - "basic"  [5ee9a]
      container33 [ContainerWidget2]
      form1 [FormWidget2]
      button111 [ButtonWidget2] "Check Stats"
      table72 [TableWidget2]
      ContentCounts2 [TableWidget2]
      table73 [TableWidget2]
      table74 [TableWidget2]
      table75 [TableWidget2]
  - "content"  [52a54]
      container15 [ContainerWidget2]
      container19 [ContainerWidget2]
      container17 [ContainerWidget2]
      container18 [ContainerWidget2]
  - "buzz"  [6ac7c]
      tabbedContainer12 [ContainerWidget2]
  - "cosmetic"  [1e370]
      text215 [TextWidget2]
      button80 [ButtonWidget2] "Remove Cosmetic and Shop Receipt"
      button105 [ButtonWidget2] "Check Purchases"
      shopPurchases [TableWidget2]
  - "imagegen"  [97f52]
      button78 [ButtonWidget2] "Check Generation Stats"
      textInput11 [TextInputWidget2] "Number of days to look back"
      table56 [TableWidget2]
  - "loratrain"  [fa5e8]
      text197 [TextWidget2]
      button108 [ButtonWidget2] "Check Lora Trainings"
      table76 [TableWidget2]
  - "bounties"  [c6d76]
      tabbedContainer9 [ContainerWidget2]
  - "comments"  [a0565]
      button116 [ButtonWidget2] "Check Comments"
      button40 [ButtonWidget2] "Delete Comments"
      text206 [TextWidget2]
      button113 [ButtonWidget2] "ToS Comments"
      segmentedControl1 [SegmentedControlWidget] "Label"
      CombinedComments [TableWidget2]
      textInput2 [TextInputWidget2]
      table69 [TableWidget2]
  - "leaderboard"  [8cb0b]
      text194 [TextWidget2]
      button110 [ButtonWidget2] "Check Leaderboard"
      container25 [ContainerWidget2]
      container27 [ContainerWidget2]
      container24 [ContainerWidget2]
      container28 [ContainerWidget2]
      container26 [ContainerWidget2]
      container23 [ContainerWidget2]
  - "socials"  [d1853]
      button42 [ButtonWidget2] "Purge Bio"
      image3 [ImageWidget2]
      image5 [ImageWidget2]
      button41 [ButtonWidget2] "Look at Cover Image"
      button99 [ButtonWidget2] "Look at PFP"
      bioInput [TextAreaWidget] "Bio"
      messageInput [TextAreaWidget] "Message"
      locationInput [TextInputWidget2] "Location"
      button107 [ButtonWidget2] "Check Bio and Socials"
      container22 [ContainerWidget2]
      UserSocialViewtbl [TableWidget2]
  - "reports"  [ec7cd]
      tabbedContainer10 [ContainerWidget2]
  - "reviews"  [d0fd4]
      button76 [ButtonWidget2] "Check Reviews"
      tabbedContainer8 [ContainerWidget2]
  - "activity"  [5542d]  — empty
  - "reactions"  [73f3b]
      tabbedContainer13 [ContainerWidget2]
  - "moderationactivity"  [06327]
      text199 [TextWidget2]
      select39 [SelectWidget2] "Action"
      select40 [SelectWidget2] "Type"
      table37 [TableWidget2]
      textArea4 [TextAreaWidget] "Label"
  - "chat"  [c0455]
      button106 [ButtonWidget2] "Check Chat Messages"
      table40 [TableWidget2]
  - "civitaiscore"  [babcc]
      text218 [TextWidget2]
      button104 [ButtonWidget2] "Check Score"
      table64 [TableWidget2]
      table65 [TableWidget2]
      table66 [TableWidget2]
  - "admin"  [666c1]
      modal2 [ModalWidget]
      modal4 [ModalWidget]
      button18 [ButtonWidget2] "{{UserContent?.data?.isModerator[0] == true ? 'Deactivate Mo"
      button83 [ButtonWidget2] "Remove Buzz-Block"
      button84 [ButtonWidget2] "Add Buzz-Block"
      button85 [ButtonWidget2] "Generator Buzz Earnings"
  - "notifications"  [8b154]
      textInput16 [TextInputWidget2] "Number of Notifs"
      button94 [ButtonWidget2] "Check Notifications"
      button25 [ButtonWidget2] "Delete Notification"
      table70 [TableWidget2]
      notificationInsert [FormWidget2]
  - "timedmute"  [2a5a4]
      muteStart [DateTimeWidget] "Mute Start (UTC)"
      muteEnd [DateTimeWidget] "Mute End (UTC)"
      currentUTCTimeDisplay [TimeWidget] "Current UTC Time"
      muteReason [TextAreaWidget] "Mute Reason"
      button28 [ButtonWidget2] "🔃"
      presetMutes [SelectWidget2] "Pre-Set Mute Period"
      button36 [ButtonWidget2] "Notify User (Notification)"
      button26 [ButtonWidget2] "Activate Timed Mute"
      button27 [ButtonWidget2] "Revoke Timed Mute"
      tblviewMutes [TableWidget2]
  - "promptaudit"  [dba13]
      text200 [TextWidget2]
      button112 [ButtonWidget2] "Check Blocked Prompts"
      table35 [TableWidget2]
      promptFilter [TextInputWidget2] "Filter Prompt"
      promptAmount [NumberInputWidget] "# of Prompts"
      table61 [TableWidget2]
      tabs14 [TabsWidget2]   (not in a pane)

### container29   [ContainerWidget2] — 1 pane(s)  (inside tabbedContainer12)
  - "View 1"  [c4ac1]
      table58 [TableWidget2]
      containerTitle36 [TextWidget2]   (not in a pane)

### container30   [ContainerWidget2] — 1 pane(s)  (inside tabbedContainer12)
  - "View 1"  [c4ac1]
      splitButton1 [SplitButtonWidget]
      containerTitle37 [TextWidget2]   (not in a pane)

### container32   [ContainerWidget2] — 1 pane(s)  (inside form1)
  - "View 1"  [c4ac1]
      UserNotesInput [TextAreaWidget] "{{SelectUserNotes.data.notes.length > 0 ? 'Note 1 of ' + Sel"
      button62 [ButtonWidget2] "Open Notes"
      containerTitle39 [TextWidget2]   (not in a pane)

### container33   [ContainerWidget2] — 1 pane(s)  (inside MainContentContainer)
  - "View 1"  [c4ac1]
      button93 [ButtonWidget2] "Freshdesk"
      button70 [ButtonWidget2] "Refresh Session"
      button81 [ButtonWidget2] "{{ Array.from(new Set(formatDataAsArray(SimilarIps.data).map"
      button14 [ButtonWidget2] "{{UserContent?.data?.muted[0] == true ? 'Unmute' : 'Mute' }}"
      modal7 [ModalWidget]
      button117 [ButtonWidget2] "Profile"
      button102 [ButtonWidget2] "Clear Cache"
      containerTitle40 [TextWidget2]   (not in a pane)

### container34   [ContainerWidget2] — 1 pane(s)  (inside form1)
  - "View 1"  [c4ac1]
      subscriberForm2 [TextInputWidget2] "Subscriber Until"
      textInput13 [TextInputWidget2] "Paddle Customer ID"
      button72 [ButtonWidget2] "Paddle"
      button92 [ButtonWidget2] "Stripe"
      containerTitle41 [TextWidget2]   (not in a pane)

### container35   [ContainerWidget2] — 1 pane(s)  (inside form1)
  - "View 1"  [c4ac1]
      text225 [TextWidget2]
      bannedAtForm2 [TextInputWidget2] "Banned Date"
      modal6 [ModalWidget]
      text229 [TextWidget2]
      containerTitle42 [TextWidget2]   (not in a pane)

### container36   [ContainerWidget2] — 1 pane(s)  (inside form1)
  - "View 1"  [c4ac1]
      text212 [TextWidget2]
      mutedForm [CheckboxWidget2] "Muted"
      checkbox2 [CheckboxWidget2] "Banned"
      isModeratorForm [CheckboxWidget2] "Moderator"
      acceptedTOSForm [CheckboxWidget2] "Accepted TOS"
      FrontPageCuratorForm4 [CheckboxWidget2] "Excluded Leaderboards"
      FrontPageCuratorForm7 [CheckboxWidget2] "Buzz-Blocked"
      FrontPageCuratorForm2 [CheckboxWidget2] "FP Curator"
      alert1 [AlertWidget] "Comment Spammer"
      containerTitle43 [TextWidget2]   (not in a pane)

### review_conf_window   [ModalWidget] — MODAL
    text147 [TextWidget2]
    button2 [ButtonWidget2] "Cancel"
    button1 [ButtonWidget2] "Delete"

### modal2   [ModalWidget] — MODAL
    text168 [TextWidget2]
    cosmeticUnlockWindow [ModalWidget]
    text170 [TextWidget2]
    tblAvailableCosmetics [TableWidget2]
    cosmeticDeleteWindow [ModalWidget]
    text169 [TextWidget2]
    tblUnlockedCosmetics [TableWidget2]

### modal6   [ModalWidget] — MODAL
    text166 [TextWidget2]
    banReason [SelectWidget2] "Reason for ban"
    button98 [ButtonWidget2] "{{!UserContent.data?.bannedAt[0] ? "Ban with no Reason" : "U"
    button20 [ButtonWidget2] "{{!UserContent.data?.bannedAt[0] ? "Ban with Reason" : "Unba"

### modal7   [ModalWidget] — MODAL
    text167 [TextWidget2]
    button21 [ButtonWidget2] "Purge Content"

### cosmeticUnlockWindow   [ModalWidget] — MODAL
    text172 [TextWidget2]
    button29 [ButtonWidget2] "Give Badges"
    button30 [ButtonWidget2] "Cancel"

### cosmeticDeleteWindow   [ModalWidget] — MODAL
    text177 [TextWidget2]
    button34 [ButtonWidget2] "Remove Badges"
    button35 [ButtonWidget2] "Cancel"

### form1   (15)
    deletedAtForm2 [TextInputWidget2] "Deleted Date"
    mutedAtForm2 [TextInputWidget2] "Muted Date"
    accountCreatedForm2 [TextInputWidget2] "Account Created At"
    enableEditsSwitch [SwitchWidget2] "Enable Edits"
    container36 [ContainerWidget2]
    formButton1 [ButtonWidget2] "Save"
    usernameForm2 [TextInputWidget2] "Username"
    userid6 [TextInputWidget2] "UserID"
    fullNameForm2 [TextInputWidget2] "Full Name"
    emailForm2 [TextInputWidget2] "Email"
    emailVerifiedForm2 [TextInputWidget2] "Email Verified Date"
    divider4 [DividerWidget]
    container32 [ContainerWidget2]
    container34 [ContainerWidget2]
    container35 [ContainerWidget2]

### notificationInsert   (4)
    notificationLink [TextInputWidget2] "Notification Link"
    formTitle1 [TextWidget2]
    notificationMessage [TextAreaWidget] "Notification Message"
    formButton2 [ButtonWidget2] "Send Notification"

## queries

### GetFreshdesk   [RESTQuery / REST-WithoutResource] 
    depends on: UserContent.data.email[0]
    https://civitai.freshdesk.com/api/v2/search/contacts?query="email:'{{ UserContent.data.email[0] }}'"

### RegistrationIP   [SqlQuery / Clickhouse] 
    depends on: userIdVar.value
    SELECT * 
    FROM default.userActivities 
    WHERE targetUserId = {{userIdVar.value}}
    AND NOT isIPAddressInRange(ip, '10.124.0.0/16')
    AND "type" != 'Banned'

### GetModelVersions   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT DISTINCT 
      mv."id" AS "modelVersionId", 
      m."name", 
      m."id" AS "modelId"
    FROM "ModelVersion" mv
    JOIN "Model" m ON m."id" = mv."modelId"
    WHERE "userId" = {{userIdVar.value}}

### GensPerResource   [SqlQuery / Clickhouse - protection disabled] 
    depends on: textInput11.value, GetModelVersions.data.modelVersionId
    SELECT
        modelVersionId,
        sum(count) as count
    FROM daily_resource_generation_counts
    WHERE createdDate >= subtractDays(toStartOfDay(now()), {{textInput11.value}})
    AND modelVersionId IN({{GetModelVersions.data.modelVersionId}})
    GROUP BY modelVersionId

### CreatorClub   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT 
      u.id
    FROM 
      "UserStripeConnect" usc
    JOIN 
      "User" u ON u."id" = usc."userId"
    JOIN (
      SELECT 
        "userId",
        MAX("followerCount") AS "followerCount"
      FROM 
        "UserMetric"
      GROUP BY 
        "userId"
    ) um ON u."id" = um."userId"
    GROUP BY 
      u."username",  
      usc."userId",  
      usc."connectedAccountId", 
      usc."status", 
      usc."payoutsEnabled",
      usc."chargesEnabled",
      um."followerCount";

### CreatorClubBuzz   [SqlQueryUnified / BuzzTemp] 
    depends on: CreatorClub.data.userId
    SELECT
      "Id",
      "Balance"
    FROM "Accounts"
    WHERE "Id" = ANY({{CreatorClub.data.userId}})

### CreatorModel   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: monthSelect.value, CreatorClub.data.userId
    SELECT 
      SUM(CASE WHEN "type" = 'Checkpoint' THEN 1 ELSE 0 END) AS checkpoint,
      SUM(CASE WHEN "type" != 'Checkpoint' THEN 1 ELSE 0 END) AS lora,
      "userId",
      STRING_AGG(DATE("createdAt")::TEXT, ', ') AS all_createdAt
    FROM 
      "Model" 
    WHERE "createdAt" > DATE_TRUNC('month', TO_DATE({{monthSelect.value}}, 'YYYY-MM-DD'))
     AND "createdAt" < DATE_TRUNC('month', TO_DATE({{monthSelect.value}}, 'YYYY-MM-DD')) + INTERVAL '1 month'
      AND "userId" = ANY({{CreatorClub.data.userId}})
    GROUP BY 
      "userId";

### CreatorImages   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: CreatorClub.data.userId, monthSelect.value
    SELECT COUNT(*), "userId" 
    FROM "Image"
    WHERE "userId" = ANY({{CreatorClub.data.userId}})
    AND "createdAt" > DATE_TRUNC('month', TO_DATE({{monthSelect.value}}, 'YYYY-MM-DD'))
     AND "createdAt" < DATE_TRUNC('month', TO_DATE({{monthSelect.value}}, 'YYYY-MM-DD')) + INTERVAL '1 month'
    GROUP BY "userId"

### ModeratorList   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT * FROM "User"
    WHERE "isModerator" = 'true'
    ORDER BY "createdAt" DESC

### UserBio   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT 
      i."url",
      up."coverImageId",
      up."bio",
      up."message",
      up."location"
    FROM "UserProfile" up
    LEFT JOIN "Image" i ON up."coverImageId" = i."id"
    WHERE up."userId" = {{userIdVar.value}}

### ComboComments   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT 
      "id", 
      "parentId" AS "parentId", 
      "createdAt", 
      "content", 
      "nsfw", 
      "tosViolation", 
      CASE 
        WHEN "parentId" IS NOT NULL THEN 
          concat('https://civitai.com/models/' || "modelId" || '?dialog=commentThread&commentId=' || "parentId" || '&highlight=' || "id")
        ELSE 
          concat('https://civitai.com/models/' || "modelId" || '?dialog=commentThread&commentId=' || "id" || '&highlight=' || "id")
      END AS "url",
      'Comment' AS "Source"
    FROM "Comment" 
    WHERE "userId" = {{ userIdVar.value }}
    
    
    UNION ALL
    
    SELECT 
      c."id", 
      c."threadId" AS "parentId", 
      c."createdAt", c."content", 
      c."nsfw", 
      c."tosViolation", 
      CASE 
        WHEN t."imageId" IS NOT NULL THEN 
          concat('https://civitai.com/images/' || t."imageId")
        WHEN t."articleId" IS NOT NULL THEN
          concat('https://civitai.com/articles/' || t."articleId" || '?highlight=' || c."id" || '#comments')
        ELSE
          'https://civitai.com/TellSebAboutThisNotWorking'
      END AS "url",
      'CommentV2' AS "Source"
    FROM "CommentV2" c
    JOIN "Thread" t ON c."threadId" = t."id"
    WHERE c."userId" = {{ userIdVar.value }}
    
    ORDER BY "createdAt" DESC

### LogPurge   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ReToolActions

### LogBan   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ReToolActions

### RemoveCosmetics   [SqlQueryUnified / Prod] 
    GUI-mode write → table: UserCosmetic
    

### ReviewList   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT 
      rr."id",
      rr."createdAt", 
      rr."details", 
      rr."nsfw", 
      rr."tosViolation", 
      rr."exclude", 
      rr."rating",  
      rr."modelId",
      rr."modelVersionId",
      u."username" AS ModelCreator
    FROM "ResourceReview" rr 
    JOIN "Model" m ON m."id" = rr."modelId"
    JOIN "User" u ON u."id" = m."userId"
    WHERE rr."userId" = {{ userIdVar.value }}
    ORDER BY rr."createdAt" DESC

### SubmittedReviewImageCount   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: ReviewList.data.id
    SELECT *
    FROM "ResourceReviewHelper" WHERE "resourceReviewId" = ANY({{ReviewList.data.id}})

### LogDeleteReviews   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ReToolActions

### SubscriberList   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT 
    "User"."createdAt",
    "User"."id",
    "User"."username",
    "User"."name",
    "User"."email",
    "User"."customerId",
    "User"."subscriptionId",
    "User"."onboardingSteps",
    "CustomerSubscription"."status",
    "CustomerSubscription"."currentPeriodStart"
    FROM "User"
    JOIN "CustomerSubscription" ON "User"."id" = "CustomerSubscription"."userId"
    WHERE "subscriptionId" IS NOT NULL
    ORDER BY "createdAt" DESC

### SubTiers   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT COUNT(*), p."name", cs."status"
    FROM "CustomerSubscription" cs
    JOIN "Product" p ON p."id" = cs."productId"
    WHERE "status" = 'active'
    GROUP BY p."name", cs."status"
    ORDER BY 1 DESC

### SubTierStatus   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT COUNT(*), p."name", cs."status"
    FROM "CustomerSubscription" cs
    JOIN "Product" p ON p."id" = cs."productId"
    WHERE "status" != 'active'
    GROUP BY p."name", cs."status"
    ORDER BY 1 DESC

### CurrentUTCTime   [JavascriptQuery / JavascriptQuery] 
    const currentTime = moment.utc()
    
    return currentTime;

### ActivateSystemMute   [SqlQueryUnified / Prod] 
    GUI-mode write → table: User
    

### RevokeTimedMutes   [SqlQueryUnified / retool_db] 
    depends on: userIdVar.value
    DELETE FROM "TimedMutes"
    WHERE "userId" = {{userIdVar.value}}

### LogCurator   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ReToolActions

### LogToggleMute   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ReToolActions
    

### ToggleMod   [SqlQueryUnified / Prod] 
    GUI-mode write → table: User

### UpdateUserDeets   [SqlQueryUnified / Prod] 
    GUI-mode write → table: User
    

### LogUpdateUserDeets   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ReToolActions

### CollectionCount   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT 'Collections' AS "ContentType",
    COUNT(*) AS "Count" 
    FROM "Collection"
    WHERE "userId" = {{userIdVar.value}}

### PotentialSpammer   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT
      "userId",
      COUNT(*) AS comment_count
    FROM "CommentV2"
    WHERE "createdAt" > now() - INTERVAL '2 days'
    AND "userId" = {{userIdVar.value}}
    GROUP BY "userId"
    HAVING COUNT(*) > 2
    
    
    UNION ALL
    
    SELECT
      "userId",
      COUNT(*) AS comment_count
    FROM "Comment"
    WHERE "createdAt" > now() - INTERVAL '2 days'
    AND "userId" = {{userIdVar.value}}
    GROUP BY "userId"
    HAVING COUNT(*) > 2
    
    ORDER BY comment_count DESC;

### ImageComments   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT 'Image Comments' AS "ContentType",
    COUNT(*) AS "Count" 
    FROM "CommentV2"
    WHERE "userId" = {{userIdVar.value}}

### ReviewCount   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT 'Reviews' AS "ContentType", COUNT("ResourceReview"."id") AS "Count"
    FROM "ResourceReview" 
    WHERE "ResourceReview"."userId" = {{ userIdVar.value }}

### ModelCount2   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT 'Models' AS "ContentType", COUNT(*) AS "Count" FROM "Model"
    WHERE "userId" = {{userIdVar.value}}

### ImageCount   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT 'Images' AS "ContentType", COUNT(*) AS "Count" FROM "Image"
    WHERE "userId" = {{userIdVar.value}}

### ArticleCount   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT 'Articles' AS "ContentType", COUNT(*) AS "Count" FROM "Article"
    WHERE "userId" = {{userIdVar.value}}

### PostCount   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT 'Posts' AS "ContentType", COUNT(*) AS "Count" FROM "Post"
    WHERE "userId" = {{userIdVar.value}}

### CommentCount   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT 
        COUNT("Comment"."id") AS "NumComments", 
        SUM(CASE WHEN "Comment"."tosViolation" = true THEN 1 ELSE 0 END) AS "NumTOSViolations",
        SUM(CASE WHEN "Comment"."hidden" = true THEN 1 ELSE 0 END) AS "NumHidden"
    FROM 
        "Comment" 
    WHERE "Comment"."userId" = {{ userIdVar.value }}

### ReportCount   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT COUNT("Report"."id") AS totalReports,
    SUM(CASE WHEN "Report"."status" = 'Actioned' THEN 1 ELSE 0 END) AS "NumActioned",
    SUM(CASE WHEN "Report"."status" = 'Unactioned' THEN 1 ELSE 0 END) AS "NumUnactioned",
    SUM(CASE WHEN "Report"."status" = 'Pending' THEN 1 ELSE 0 END) AS "NumPending",
    ROUND(
        (SUM(CASE WHEN "Report"."status" = 'Actioned' THEN 1 ELSE 0 END)::decimal / 
         GREATEST(COUNT("Report"."id"), 1)) * 100, 2
      ) AS "ActionedPercentage",
      ROUND(
        (SUM(CASE WHEN "Report"."status" = 'Unactioned' THEN 1 ELSE 0 END)::decimal / 
         GREATEST(COUNT("Report"."id"), 1)) * 100, 2
      ) AS "MissPercentage"
    FROM "Report"
    WHERE "Report"."userId" = {{ userIdVar.value }}

### ModelCount   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT 
        COUNT(*) AS "NumModels",
        SUM(CASE WHEN "Model"."nsfw" = true THEN 1 ELSE 0 END) AS "NumNSFW",
        SUM(CASE WHEN "Model"."tosViolation" = true THEN 1 ELSE 0 END) AS "NumTos",
        SUM(CASE WHEN "Model"."poi" = true THEN 1 ELSE 0 END) AS "NumPoi",
        SUM(CASE WHEN "Model"."locked" = true THEN 1 ELSE 0 END) AS "NumLocked",
        SUM(CASE WHEN "Model"."deletedAt" IS NOT NULL THEN 1 ELSE 0 END) AS "NumDeleted"
    FROM 
        "Model" 
    WHERE "Model"."userId" = {{ userIdVar.value }}

### UserSubscriptionStatus   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT "CustomerSubscription".metadata ,p."name", "status", "priceId", "productId", "cancelAtPeriodEnd", "canceledAt", "currentPeriodStart", DATE("currentPeriodEnd") AS "currentPeriodEnd", p."provider", "CustomerSubscription"."id" FROM "CustomerSubscription"
    LEFT JOIN "Product" p ON p."id" = "CustomerSubscription"."productId"
    WHERE "CustomerSubscription"."userId" = {{ userIdVar.value }}
    --AND status = 'active'

### UserSubscriptionStatusAnnual   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT pr.name FROM "CustomerSubscription" cs
    JOIN "Price" p ON cs."priceId" = p.id 
    JOIN "Product" pr ON pr.id = p."productId"
    WHERE cs."userId" = {{ userIdVar.value }}
    AND interval IN('year')
    LIMIT 1;

### UserIDByUsername   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: username.value.trim()
    SELECT "User"."id"
    FROM "User"
    WHERE "User"."username" = {{ username.value.trim() }}

### UserIDByEmail   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: email.value.trim()
    SELECT "User"."id"
    FROM "User"
    WHERE "User"."email" = {{ email.value.trim() }}

### ReportedCommentCount   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT COUNT(1) AS "reportedCommentCount"
    FROM "Comment" 
    LEFT JOIN "CommentReport" ON "Comment"."id" = "CommentReport"."commentId"
    LEFT JOIN "Report" ON "CommentReport"."reportId" = "Report"."id"
    LEFT JOIN "User" "reportedBy" ON "Report"."userId" = "reportedBy"."id"
    WHERE "Comment"."userId" = {{ userIdVar.value }}
    AND "CommentReport"."reportId" IS NOT NULL

### ReportedImageCount   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT COUNT("Image"."id") AS "reportedImageCount"
    FROM "Image" 
    LEFT JOIN "ImageReport" ON "Image"."id" = "ImageReport"."imageId"
    LEFT JOIN "Report" ON "ImageReport"."reportId" = "Report"."id"
    LEFT JOIN "User" "reportedBy" ON "Report"."userId" = "reportedBy"."id"
    WHERE "Image"."userId" = {{ userIdVar.value }}
    AND "ImageReport"."reportId" IS NOT NULL

### ReportedModelCount   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT COUNT("Model"."id") AS "reportedCount"
    FROM "Model" 
    LEFT JOIN "ModelReport" ON "Model"."id" = "ModelReport"."modelId"
    LEFT JOIN "Report" ON "ModelReport"."reportId" = "Report"."id"
    LEFT JOIN "User" "reportedBy" ON "Report"."userId" = "reportedBy"."id"
    WHERE "Model"."userId" = {{ userIdVar.value }}
    AND "ModelReport"."reportId" IS NOT NULL

### ReportsSubmitted   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT "Report"."id", "Report"."createdAt", "Report"."details", "Report"."internalNotes", "Report"."alsoReportedBy", "Report"."previouslyReviewedCount", "Report"."reason", "Report"."status", "Report"."statusSetAt", umod.username AS "StatusSetBy", "Report"."userId", COALESCE("details"->>'violation', "details"->>'reason') AS "ParsedDetails", "details"->>'comment' AS "Comment", "details"->>'reportType' AS "ReportType", "ImageReport"."imageId" AS "imageId", "ModelReport"."modelId" AS "modelId"
    FROM "Report"
    LEFT JOIN "ImageReport" ON "Report"."id" = "ImageReport"."reportId"
    LEFT JOIN "ModelReport" ON "Report"."id" = "ModelReport"."reportId"
    LEFT JOIN "User" umod ON umod.id = "Report"."statusSetBy"
    WHERE "Report"."userId" = {{ userIdVar.value }}
    ORDER BY "Report"."createdAt" DESC

### UserRank   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    WITH RankedResults AS (
      SELECT
        "leaderboardId",
        "position",
        "metrics",
        "score",
        ROW_NUMBER() OVER (PARTITION BY "leaderboardId" ORDER BY "createdAt" DESC) AS rn
      FROM
        "LeaderboardResult"
      WHERE
        "userId" = {{userIdVar.value}}
        AND "position" < 100
        AND "createdAt" >= NOW() - INTERVAL '30 days'
    )
    SELECT
      *
    FROM
      RankedResults
    WHERE
      rn = 1;

### UserStats   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT "userId", "followerCountAllTime", "followingCountAllTime", "uploadCountAllTime", "downloadCountAllTime", ROUND("ratingAllTime"::numeric, 2) AS "ratingAllTime"  FROM "UserStat"
    WHERE "UserStat"."userId" = {{ userIdVar.value }}

### UserContent   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT
      u."customerId",
      u.email,
      u.id,
      u.username,
      u."createdAt",
    
      u."autoplayGifs",
      u."blurNsfw",
      u."showNsfw",
      u."browsingLevel",
    
      u."bannedAt",
      u.muted,
      u."mutedAt",
    
      TO_CHAR(u."createdAt"::timestamp, 'MM/DD/YYYY HH24:MI') AS "createdAt",
      TO_CHAR(u."deletedAt"::timestamp, 'MM/DD/YYYY HH24:MI') AS "deletedAt",
      TO_CHAR(u."emailVerified"::timestamp, 'MM/DD/YYYY HH24:MI') AS "emailVerified",
    
      u."filePreferences",
      u.image,
      u."isModerator",
      u."leaderboardShowcase",
      u.name,
      u."subscriptionId",
      u."profilePictureId",
      u.onboarding,
      u."excludeFromLeaderboards",
      u."rewardsEligibility",
      u."paddleCustomerId",
    
      u.meta #>> '{banDetails,reasonCode}' AS "banReason",
      u.meta #>> '{banDetails,detailsInternal}' AS "banDetails",
    
      COALESCE(csam.reports, '[]'::jsonb) AS "csamReports",
      COALESCE(restrictions.items, '[]'::jsonb) AS "restrictions",
      COALESCE(subscriptions.items, '[]'::jsonb) AS "subscriptions",
      COALESCE(pending_reports.items, '[]'::jsonb) AS "pendingReports"
    
    FROM "User" u
    
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        to_jsonb(cr) || jsonb_build_object(
          'reportedByUsername', reporter.username
        )
        ORDER BY cr."createdAt" DESC
      ) AS reports
      FROM "CsamReport" cr
      JOIN "User" reporter ON reporter.id = cr."reportedById"
      WHERE cr."userId" = u.id
    ) csam ON true
    
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        to_jsonb(ur) || jsonb_build_object(
          'resolvedByUsername', resolver.username
        )
        ORDER BY ur.id DESC
      ) AS items
      FROM "UserRestriction" ur
      LEFT JOIN "User" resolver ON resolver.id = ur."resolvedBy"
      WHERE ur."userId" = u.id
    ) restrictions ON true
    
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', cs.id,
          'metadata', cs.metadata,
          'productName', p.name,
          'status', cs.status,
          'priceId', cs."priceId",
          'productId', cs."productId",
          'cancelAtPeriodEnd', cs."cancelAtPeriodEnd",
          'canceledAt', cs."canceledAt",
          'currentPeriodStart', cs."currentPeriodStart",
          'currentPeriodEnd', cs."currentPeriodEnd",
          'currentPeriodEndDate', DATE(cs."currentPeriodEnd"),
          'provider', p.provider
        )
        ORDER BY cs."currentPeriodEnd" DESC NULLS LAST, cs.id DESC
      ) AS items
      FROM "CustomerSubscription" cs
      LEFT JOIN "Product" p ON p.id = cs."productId"
      WHERE cs."userId" = u.id
      -- AND cs.status = 'active'
    ) subscriptions ON true
    
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', r.id,
          'status', r.status,
          'reportedBy', reporter.username,
          'reason', r.reason,
          'createdAt', r."createdAt",
          'details', r.details,
          'alsoReportedBy', r."alsoReportedBy",
          'previouslyReviewedCount', r."previouslyReviewedCount"
        )
        ORDER BY r."createdAt" DESC
      ) AS items
      FROM "UserReport" ur
      JOIN "Report" r ON r.id = ur."reportId"
      JOIN "User" reporter ON reporter.id = r."userId"
      WHERE ur."userId" = u.id
        AND r.status IN ('Pending', 'Processing')
    ) pending_reports ON true
    
    WHERE u.id = {{ userIdVar.value }};

### SelectUserNotes   [SqlQueryUnified / retool_db] 
    depends on: userIdVar.value
    SELECT "lastUpdate", "lastUpdateBy", "notes" FROM "UserNotes"
    WHERE "userId" = {{userIdVar.value}}
    ORDER BY "lastUpdate" DESC

### InsertUpdateUserNotes   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: UserNotes

### ModelComments   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT 'Model Comments' AS "ContentType", COUNT(*) AS "Count" FROM "Comment"
    WHERE "userId" = {{userIdVar.value}}

### AllCountsUnion   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT 'Image Comments' AS "ContentType", COUNT(*) AS "Count" FROM "CommentV2"
    WHERE "userId" = {{userIdVar.value}}
    
    UNION ALL 
    
    SELECT 'Reviews' AS "ContentType", COUNT("ResourceReview"."id") AS "Count"
    FROM "ResourceReview" 
    WHERE "ResourceReview"."userId" = {{ userIdVar.value }}
    
    UNION ALL
    
    SELECT 'Models' AS "ContentType", COUNT(*) AS "Count" FROM "Model"
    WHERE "userId" = {{userIdVar.value}}
    
    UNION ALL
    
    SELECT 'Images' AS "ContentType", COUNT(*) AS "Count" FROM "Image"
    WHERE "userId" = {{userIdVar.value}}
    
    UNION ALL
    
    SELECT 'Articles' AS "ContentType", COUNT(*) AS "Count" FROM "Article"
    WHERE "userId" = {{userIdVar.value}}
    
    UNION ALL
    
    SELECT 'Posts' AS "ContentType", COUNT(*) AS "Count" FROM "Post"
    WHERE "userId" = {{userIdVar.value}}
    
    UNION ALL
    
    SELECT 'Model Comments' AS "ContentType", COUNT(*) AS "Count" FROM "Comment"
    WHERE "userId" = {{userIdVar.value}}
    
    UNION ALL
    
    SELECT 'Collections' AS "ContentType",
    COUNT(*) AS "Count" 
    FROM "Collection"
    WHERE "userId" = {{userIdVar.value}}

### PotentialSpammerV2   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT
      "userId",
      SUM(comment_count) AS total_comment_count
    FROM (
      SELECT
        "userId",
        COUNT(*) AS comment_count
      FROM "CommentV2"
      WHERE "createdAt" > now() - INTERVAL '2 days'
      AND "userId" = {{userIdVar.value}}
      GROUP BY "userId"
      HAVING COUNT(*) > 2
      
      UNION ALL
      
      SELECT
        "userId",
        COUNT(*) AS comment_count
      FROM "Comment"
      WHERE "createdAt" > now() - INTERVAL '2 days'
      AND "userId" = {{userIdVar.value}}
      GROUP BY "userId"
      HAVING COUNT(*) > 2
    ) AS subquery
    GROUP BY "userId"
    ORDER BY total_comment_count DESC;

### LogToggleMod   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ReToolActions

### ToggleMute   [SqlQueryUnified / Prod] 
    GUI-mode write → table: User

### RemoveDeserveMute   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: User

### BANAPI   [RESTQuery / REST-WithoutResource] 
    depends on: UserContent.data.id, retoolContext.configVars.WEBHOOK_TOKEN, banReason
    https://www.civitai.com/api/mod/ban-user?userId={{UserContent.data.id}}&token={{ retoolContext.configVars.WEBHOOK_TOKEN}}&reasonCode={{ banReason }}

### UNBANAPI   [RESTQuery / REST-WithoutResource] 
    depends on: UserContent.data.id, retoolContext.configVars.WEBHOOK_TOKEN
    https://www.civitai.com/api/mod/ban-user?userId={{UserContent.data.id}}&token={{ retoolContext.configVars.WEBHOOK_TOKEN}}

### PURGEAPI   [RESTQuery / REST-WithoutResource] 
    depends on: UserContent.data.id, retoolContext.configVars.WEBHOOK_TOKEN
    https://www.civitai.com/api/mod/remove-all-content?userId={{UserContent.data.id}}&token={{ retoolContext.configVars.WEBHOOK_TOKEN}}

### CuratorStatus   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT CASE 
               WHEN COUNT(*) > 0 THEN TRUE 
               ELSE FALSE 
           END AS "isCurator"
    FROM "CollectionContributor"
    WHERE "userId" = {{userIdVar.value}}
    AND permissions IN('{VIEW,ADD}', '{VIEW,ADD_REVIEW}')
    AND "collectionId" IN (104, 105, 106, 107)

### UserCosmetics   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT 
        C.*, 
        UC."cosmeticId" IS NOT NULL AS "hasCosmetic",
        UC.data->>'url' AS "cosmeticImg"
    FROM 
        "Cosmetic" AS C
    LEFT JOIN 
        "UserCosmetic" AS UC 
    ON 
        C."id" = UC."cosmeticId" AND UC."userId" = {{userIdVar.value}}
    WHERE "type" = 'Badge'
    AND UC."obtainedAt" IS NOT NULL

### AvailableCosmeticList   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: ownedCosmetics.value
    SELECT *, data->>'url' AS "cosmeticImg" FROM "Cosmetic" 
    WHERE NOT "id" = ANY({{ownedCosmetics.value}}) AND "type" = 'Badge'
    ORDER BY "id"

### UnlockCosmetics   [SqlQueryUnified / Prod] 
    GUI-mode write → table: UserCosmetic
    depends on: userIdVar.value, cosmeticId
    INSERT INTO "UserCosmetic"("userId", "cosmeticId", "obtainedAt")
    SELECT
      {{userIdVar.value}} as "userId",
      {{ cosmeticId }} as "cosmeticId",
      now() as "obtainedAt";

### ViewMutes   [SqlQueryUnified / retool_db] 
    depends on: userIdVar.value
    SELECT 
    "id",
    "userId",
    "muteStart",
    "muteEnd",
    "createdBy",
    "createdAt",
    "muteReason"
    FROM "TimedMutes"
    WHERE "userId" = {{userIdVar.value}}

### InsertUpdateTimedMute   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: TimedMutes
    

### RevokeSystemMute   [SqlQueryUnified / Prod] 
    GUI-mode write → table: User

### InsertUpdateUserNotes2   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: UserNotes

### MutedList   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT * FROM "User"
    WHERE "muted" = 'true'
    ORDER BY "createdAt" DESC

### BannedList   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT * FROM "User"
    WHERE "bannedAt" IS NOT NULL
    ORDER BY "createdAt" DESC

### Unmute   [SqlQueryUnified / Prod] 
    GUI-mode write → table: User

### UsersWithNotes   [SqlQueryUnified / retool_db] 
    SELECT * FROM "UserNotes"
    ORDER BY "lastUpdate" DESC

### AccountSocialQuery   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT * FROM "UserLink"
    WHERE "userId" = {{userIdVar.value}}

### NullSelectedSocial   [SqlQueryUnified / Prod] 
    GUI-mode write → table: UserLink

### InsertNewSocial   [SqlQueryUnified / Prod] 
    GUI-mode write → table: UserLink

### LogSocialChange   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ReToolActions

### UsersWithSocials   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT
    "UL"."id",
    "UL"."userId",
    "UL"."url",
    "UL"."type",
    "U"."username"
    FROM "UserLink" AS "UL"
    JOIN "User" AS "U"
    ON "UL"."userId" = "U"."id"

### DistinctUsersWithSocialLinks   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT COUNT(
    DISTINCT "UL"."userId") AS "UsersWithSocials"
    FROM "UserLink" AS "UL"

### CuratorList   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT DISTINCT "userId" AS id
    FROM "CollectionContributor" cc 
    WHERE cc."collectionId" IN(104, 105, 106, 107)
    AND "permissions" = '{VIEW,ADD_REVIEW}'

### UsersCreatedCurrentDay   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT
      "id",
      "username",
      "email",
      substring(email from '@(.+)$') AS domain,
      "createdAt",
      "deletedAt"
    FROM
      "User"
    WHERE
      "createdAt" > now() - INTERVAL '3 days'

### BuildClickhouseLog   [JavascriptQuery / JavascriptQuery] 
    async function RunQueries() {
      const promises = reviews.selectedRows.map(async (row) => {
        return LogToClickhouse.trigger({
          additionalScope: {
            modelId: row.modelId,
            modelVersionId: row.modelVersionId,
            rating: row.rating
          }
        });
      });
    
      await Promise.all(promises);
    }
    
    (async () => {
      await RunQueries();
      ReviewList.trigger();
      ReviewCount.trigger();
      reviews.clearSelection();
    })();

### LogToClickhouse   [SqlQuery / Clickhouse] 
    depends on: current_user.metadata.userIdCivit, modelId, modelVersionId, rating
    INSERT INTO resourceReviews(type, time, userId, modelId, modelVersionId, nsfw, rating) VALUES
    ('Delete', now(), {{current_user.metadata.userIdCivit}}, {{modelId}},{{modelVersionId}}, false, {{rating}})

### alternateAccount   [SqlQuery / Clickhouse] 
    depends on: userIdVar.value
    SELECT
        accountId,
        SUM(balance) AS Balance,
        SUM(CASE WHEN earned THEN b.balance ELSE 0 END) AS LifetimeBalance
    FROM (
        -- Earned
         SELECT
             toAccountId AS accountId,
             SUM(amount) AS balance,
             true AS earned
         FROM buzzTransactions
         GROUP BY toAccountId
    
        UNION ALL
    
        -- Spent
        SELECT
            fromAccountId AS accountId,
            -SUM(amount) AS balance,
            false AS earned
         FROM buzzTransactions
         GROUP BY fromAccountId
    ) b
    WHERE "accountId" = {{userIdVar.value}}
    GROUP BY accountId

### Receipts   [SqlQuery / Clickhouse] 
    depends on: userIdVar.value, buzzDateTime.value
    SELECT
        "type",
        "fromAccountId",
        "toAccountId",
        "amount",
        "description",
        "date",
        "transactionId",
        "externalTransactionId",
         details,
        CASE
          WHEN "fromAccountType" IN ('user', 'yellow') THEN 'Yellow'
          WHEN "fromAccountType" IN ('generation', 'blue') THEN 'Blue'
          WHEN "fromAccountType" = 'green' THEN 'Green'
          ELSE 'Unknown Color type, ask Seb to fix'
        END AS "Color"
    FROM "default"."buzzTransactions"
    WHERE "toAccountId" = {{userIdVar.value}}
    AND "date" > parseDateTimeBestEffort({{buzzDateTime.value}})
    ORDER BY "date"

### Payments   [SqlQuery / Clickhouse] 
    depends on: userIdVar.value, buzzDateTime.value
    SELECT
        "type",
        "fromAccountId",
        "toAccountId",
        "amount",
        "description",
        "date",
        "transactionId",
        "externalTransactionId",
        fromAccountType,
        details,
        CASE
          WHEN "fromAccountType" IN ('user', 'yellow') THEN 'Yellow'
          WHEN "fromAccountType" IN ('generation', 'blue') THEN 'Blue'
          WHEN "fromAccountType" = 'green' THEN 'Green'
          ELSE 'Unknown Color type, ask Seb to fix'
        END AS "Color"
    FROM "default"."buzzTransactions"
    WHERE "fromAccountId" = {{userIdVar.value}}
      AND "date" > parseDateTimeBestEffort({{buzzDateTime.value}})
    ORDER BY "transactionId", "date" DESC;

### ReceiptsUsers   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: Receipts.data.fromAccountId
    SELECT "id" ,"username"
    FROM "User"
    WHERE "id" = ANY({{ Receipts.data.fromAccountId }});

### PaymentsUsers   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: Payments.data.toAccountId
    SELECT "id" ,"username"
    FROM "User"
    WHERE "id" = ANY({{ Payments.data.toAccountId }});

### BountyList   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT b.*, bb."unitAmount" 
    FROM "Bounty" b
    JOIN "BountyBenefactor" bb
    ON b."id" = bb."bountyId"
    WHERE b."userId" = {{userIdVar.value}}

### LogCommentDelete   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ReToolActions

### RequireAuthList   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT 
     mv."id",
     mv."requireAuth",
     m."name" modelname,
     mv."name" versioname,
     m."type",
     m."status",
     m."deletedAt"
    FROM "ModelVersion" mv
    JOIN "Model" m ON mv."modelId" = m."id"
    WHERE m."status" = 'Published'
    AND mv."requireAuth" = 'True'
    ORDER BY  mv."requireAuth" DESC

### MostFollows   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: select36.value
    SELECT u."id", u."username", um."timeframe", um."followerCount", um."reviewCount", um."uploadCount"
    FROM "UserMetric" um
    JOIN "User" u ON u."id" = um."userId"
    WHERE um."timeframe" = {{select36.value}}
    ORDER BY um."followerCount" DESC
    LIMIT 100

### UserPhotoList   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT i."userId", u."username", COUNT(*) 
    FROM "Image" i
    JOIN "User" u ON i."userId" = u."id"
    GROUP BY "userId", "username"
    ORDER BY COUNT(*) DESC
    LIMIT 20

### UpdateUserProfile   [RESTQuery / REST-WithoutResource] 
    depends on: userIdVar.value
    https://civitai.com/api/mod/retool/user

### HolidayTeams   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT
      u."id",
      u."username",
      c.data ->> 'color' as color
    FROM
      "UserCosmetic" uc
      JOIN "Cosmetic" c ON uc."cosmeticId" = c.id
      JOIN "User" u ON u."id" = uc."userId"
    WHERE
      c.name LIKE 'Holiday Garland 2023%'

### HolidayTeamCounts   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT
      c.data ->> 'color' as color,
      COUNT(*) as count
    FROM
      "UserCosmetic" uc
      JOIN "Cosmetic" c ON uc."cosmeticId" = c.id
      JOIN "User" u ON u."id" = uc."userId"
    WHERE
      c.name LIKE 'Holiday Garland 2023%'
    GROUP BY
      c.data ->> 'color'

### LogNotificationSent   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ReToolActions

### ClickhouseUserActivities   [SqlQuery / Clickhouse] 
    depends on: userIdVar.value
    SELECT 
      CASE "type"
        WHEN 1 THEN 'Registration'
        WHEN 2 THEN 'Account closure'
        WHEN 3 THEN 'Subscribe'
        WHEN 4 THEN 'Cancel'
        WHEN 5 THEN 'Donate'
        WHEN 6 THEN 'Adjust Moderated Content Settings'
        WHEN 7 THEN 'Banned'
        WHEN 8 THEN 'Unbanned'
        WHEN 9 THEN 'Muted'
        WHEN 10 THEN 'Unmuted'
        WHEN 11 THEN 'RemoveContent'
        ELSE 'Unknown, can ask seb to update if necessary'
      END AS details,
      "time" AS createdAt,
      "userId" AS modName,
      null AS entityId,
      'Account' AS entityTyp,
      null AS reason
    FROM "default"."userActivities" 
    WHERE "targetUserId" = {{userIdVar.value}}
    AND NOT "userId" = {{userIdVar.value}}
    AND NOT type = 14
    
    UNION ALL
    
    SELECT
      CASE "type"
        WHEN 1 THEN 'Create'
        WHEN 2 THEN 'Delete'
        WHEN 3 THEN 'DeleteTOS'
        WHEN 4 THEN 'Tags'
        WHEN 5 THEN 'Resources'
        WHEN 6 THEN 'Restore'
        WHEN 7 THEN 'Play?'
        ELSE 'Unknown'
      END AS details,
      "time" AS createdAt,
      "userId" AS modName,
      "imageId" AS entityId,
      'Image' AS entityType,
      "tosReason" AS reason
    FROM "default"."images"
    WHERE "ownerId" = {{userIdVar.value}}
    AND NOT "userId" = {{userIdVar.value}}
    
    ORDER BY "time" DESC

### RetoolActions   [SqlQueryUnified / retool_db] 
    depends on: userIdVar.value
    SELECT
      "ActionType" AS details,
      "Event" AS createdAt,
      "User" AS modName
    FROM
      "ReToolActions"
    WHERE
      "ActionType" LIKE '% ' || {{userIdVar.value}} || '%'

### GetBlockedPrompts   [SqlQuery / Clickhouse] 
    depends on: userIdVar.value
    SELECT 
      prompt,
      negativePrompt,
      time,
      CASE 
        WHEN source = 'Regex' THEN 'Regex'
        WHEN source = 'External' THEN 'OpenAI'
        ELSE 'Unknown'
      END AS source
    FROM prohibitedRequests
    WHERE userId = {{userIdVar.value}}

### RetoolNotes   [SqlQueryUnified / retool_db] 
    depends on: userIdVar.value
    SELECT
      "notes" AS details,
      "lastUpdate" AS createdAt,
      "lastUpdateBy" AS modName
    FROM
      "UserNotes"
    WHERE
      "userId" = {{userIdVar.value}}

### ReportsReceived   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT
      r.*,
      rr."modelId" AS entityId,
      'Model' AS entityType,
      concat('https://civitai.com/models/' || rr."modelId") AS link,
      umod."username" AS statusSetByUsername
    FROM
      "Report" r
      LEFT JOIN "ModelReport" rr ON r."id" = rr."reportId"
      LEFT JOIN "Model" e ON e."id" = rr."modelId"
      LEFT JOIN "User" umod ON r."statusSetBy" = umod."id"
    WHERE
      e."userId" = {{userIdVar.value}}
    
    UNION ALL
    
    SELECT
      r.*,
      rr."imageId" AS entityId,
      'Image' AS entityType,
      concat('https://civitai.com/images/' || rr."imageId") AS link,
      umod."username" AS statusSetByUsername
    FROM
      "Report" r
      LEFT JOIN "ImageReport" rr ON r."id" = rr."reportId"
      LEFT JOIN "Image" e ON e."id" = rr."imageId"
      LEFT JOIN "User" umod ON r."statusSetBy" = umod."id"
    WHERE
      e."userId" = {{userIdVar.value}}
    
    UNION ALL
    
    SELECT
      r.*,
      rr."postId" AS entityId,
      'Post' AS entityType,
      concat('https://civitai.com/posts/' || rr."postId") AS link,
      umod."username" AS statusSetByUsername
    FROM
      "Report" r
      LEFT JOIN "PostReport" rr ON r."id" = rr."reportId"
      LEFT JOIN "Post" e ON e."id" = rr."postId"
      LEFT JOIN "User" umod ON r."statusSetBy" = umod."id"
    WHERE
      e."userId" = {{userIdVar.value}}
    
    UNION ALL
    
    SELECT
      r.*,
      rr."bountyId" AS entityId,
      'Bounty' AS entityType,
      concat('https://civitai.com/bounties/' || rr."bountyId") AS link,
      umod."username" AS statusSetByUsername
    FROM
      "Report" r
      LEFT JOIN "BountyReport" rr ON r."id" = rr."reportId"
      LEFT JOIN "Bounty" e ON e."id" = rr."bountyId"
      LEFT JOIN "User" umod ON r."statusSetBy" = umod."id"
    WHERE
      e."userId" = {{userIdVar.value}}
    
    UNION ALL
    
    SELECT
      r.*,
      rr."bountyEntryId" AS entityId,
      'BountyEntry' AS entityType,
      concat('https://civitai.com/bounties/' || b."id" || '/entries/' || rr."bountyEntryId") AS link,
      umod."username" AS statusSetByUsername
    FROM
      "Report" r
      LEFT JOIN "BountyEntryReport" rr ON r."id" = rr."reportId"
      LEFT JOIN "BountyEntry" e ON e."id" = rr."bountyEntryId"
      LEFT JOIN "Bounty" b ON b."id" = e."bountyId"
      LEFT JOIN "User" umod ON r."statusSetBy" = umod."id"
    WHERE
      e."userId" = {{userIdVar.value}}
    
    UNION ALL
    
    SELECT
      r.*,
      rr."articleId" AS entityId,
      'Article' AS entityType,
      concat('https://civitai.com/articles/' || rr."articleId") AS link,
      umod."username" AS statusSetByUsername
    FROM
      "Report" r
      LEFT JOIN "ArticleReport" rr ON r."id" = rr."reportId"
      LEFT JOIN "Article" e ON e."id" = rr."articleId"
      LEFT JOIN "User" umod ON r."statusSetBy" = umod."id"
    WHERE
      e."userId" = {{userIdVar.value}}
    
    UNION ALL
    
    SELECT
      r.*,
      rr."userId" AS entityId,
      'User' AS entityType,
      concat('https://civitai.com/user/' || e."username") AS link,
      umod."username" AS statusSetByUsername
    FROM
      "Report" r
      LEFT JOIN "UserReport" rr ON r."id" = rr."reportId"
      LEFT JOIN "User" e ON e."id" = rr."userId"
      LEFT JOIN "User" umod ON r."statusSetBy" = umod."id"
    WHERE
      e."id" = {{userIdVar.value}}
    
    UNION ALL
    
    SELECT
      r.*,
      rr."collectionId" AS entityId,
      'Collection' AS entityType,
      concat('https://civitai.com/collections/' || rr."collectionId") AS link,
      umod."username" AS statusSetByUsername
    FROM
      "Report" r
      LEFT JOIN "CollectionReport" rr ON r."id" = rr."reportId"
      LEFT JOIN "Collection" e ON e."id" = rr."collectionId"
      LEFT JOIN "User" umod ON r."statusSetBy" = umod."id"
    WHERE
      e."userId" = {{userIdVar.value}}
    
    UNION ALL
    
    SELECT
      r.*,
      rr."commentId" AS entityId,
      'Comment' AS entityType,
      concat('https://civitai.com/models/' || 'TellSebIfThisNeedsToWork') AS link,
      umod."username" AS statusSetByUsername
    FROM
      "Report" r
      LEFT JOIN "CommentReport" rr ON r."id" = rr."reportId"
      LEFT JOIN "Comment" e ON e."id" = rr."commentId"
      LEFT JOIN "User" umod ON r."statusSetBy" = umod."id"
    WHERE
      e."userId" = {{userIdVar.value}}
    
    UNION ALL
    
    SELECT
      r.*,
      rr."commentV2Id" AS entityId,
      'CommentV2' AS entityType,
      concat('https://civitai.com/models/' || 'TellSebIfThisNeedsToWork') AS link,
      umod."username" AS statusSetByUsername
    FROM
      "Report" r
      LEFT JOIN "CommentV2Report" rr ON r."id" = rr."reportId"
      LEFT JOIN "CommentV2" e ON e."id" = rr."commentV2Id"
      LEFT JOIN "User" umod ON r."statusSetBy" = umod."id"
    WHERE
      e."userId" = {{userIdVar.value}}
    
    UNION ALL
    
    SELECT
      r.*,
      rr."resourceReviewId" AS entityId,
      'ResourceReview' AS entityType,
      concat('https://civitai.com/reviews/' || rr."resourceReviewId") AS link,
      umod."username" AS statusSetByUsername
    FROM
      "Report" r
      LEFT JOIN "ResourceReviewReport" rr ON r."id" = rr."reportId"
      LEFT JOIN "ResourceReview" e ON e."id" = rr."resourceReviewId"
      LEFT JOIN "User" umod ON r."statusSetBy" = umod."id"
    WHERE
      e."userId" = {{userIdVar.value}}

### GeneratorCount   [SqlQuery / Clickhouse] 
    depends on: userIdVar.value
    SELECT 
      'Generations' AS "ContentType",
      COUNT(*) As "Count"
    FROM orchestration.textToImageJobs
    WHERE "userId" = {{userIdVar.value}}

### GenRateLimited   [SqlQuery / Clickhouse] 
    depends on: userIdVar.value
    SELECT
      COUNT(*) AS count
    FROM orchestration.textToImageJobs
    WHERE createdAt > now() - INTERVAL '24 HOUR'
    AND "userId" = {{userIdVar.value}}

### UserChats   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT  
      "createdAt",
      "chatId",
      "content"
    FROM "ChatMessage" 
    WHERE "userId" = {{userIdVar.value}}
    ORDER BY "createdAt" DESC

### ReceivedReviews   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT
      rr."id",
      rr."createdAt",
      rr."rating",
      rr."exclude",
      rr."details",
      rr."modelId",
      rr."modelVersionId",
      m."name",
      u."username"
    FROM "ResourceReview" rr
    JOIN "Model" m ON rr."modelId" = m."id"
    JOIN "User" u ON u."id" = rr."userId"
    WHERE m."userId" = {{userIdVar.value}}
    ORDER BY rr."createdAt" DESC

### DeleteReview   [RESTQuery / REST-WithoutResource] 
    depends on: reviews.selectedRowKeys
    https://civitai.com/api/mod/retool/review

### BountyEntryList   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT
      b."name",
      b."id" AS bountyId,
      be."id" AS bountyEntryId,
      be."createdAt",
      be."description"
    FROM "BountyEntry" be
    JOIN "Bounty" b ON b."id" = be."bountyId"
    WHERE be."userId" = {{userIdVar.value}}

### UserStrikes   [SqlQueryUnified / retool_db] 
    depends on: userIdVar.value
    SELECT * FROM "UserStrikes" WHERE "userId" = {{userIdVar.value}}

### ReportOnUser   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT
      r.status,
      u.username AS "ReportedBy",
      r.reason,
      r.id,
      r."createdAt",
      r.details,
      r."alsoReportedBy",
      r."previouslyReviewedCount"
    FROM "UserReport" ur
    JOIN "Report" r ON r."id" = ur."reportId"
    JOIN "User" u ON u."id" = r."userId"
    WHERE ur."userId" = {{userIdVar.value}}
    AND r."status" IN('Pending', 'Processing')

### InsertStrikeNotif   [RESTQuery / REST-WithoutResource] 
    depends on: token, key, userId, type, details, category
    https://civitai.com/api/mod/send-mod-notification?token={{ token }}

### LogStrikeNotif   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ReToolActions

### InsertStrike   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: UserStrikes

### LogStrike   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ReToolActions

### RefreshSession   [RESTQuery / REST-WithoutResource] 
    depends on: userIdVar.value, retoolContext.configVars.WEBHOOK_TOKEN
    https://civitai.com/api/admin/cache-check?userId={{userIdVar.value}}&reset=true&token={{ retoolContext.configVars.WEBHOOK_TOKEN}}

### Mute   [SqlQueryUnified / Prod] 
    GUI-mode write → table: User

### MuteUnmute   [RESTQuery / REST-WithoutResource] 
    depends on: !isMuted.value ? 'mute' : 'unmute', userIdVar.value
    https://civitai.com/api/mod/retool/user

### FindChats   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT DISTINCT cm."chatId" 
    FROM "ChatMember" cm
    WHERE cm."userId" = {{userIdVar.value}}

### FindChatsWithMods   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: FindChats.data.chatId, userIdVar.value
    SELECT DISTINCT cm."chatId" 
    FROM "ChatMessage" cm
    WHERE cm."chatId" = ANY({{FindChats.data.chatId}})
    AND cm."userId" IN(5418, 43555, 1, 3, 296765, 1019954, 2023372, 573, 2345535, 2760022, 2709, 984231, 203133, 2875942, 2342520, 149676)
    AND NOT cm."userId" = {{userIdVar.value}}

### PaymentsGroup   [JavascriptQuery / JavascriptQuery] 
    if(table23.groupByColumns.length > 0){
      table23.setGrouping()
    } else {
      table23.setGrouping( { columnId: 'toAccountId' })
    }

### ReceiptsGroup   [JavascriptQuery / JavascriptQuery] 
    if(table24.groupByColumns.length > 0){
      table24.setGrouping()
    } else {
      table24.setGrouping( { columnId: 'fromAccountId' })
      table24.setSort({ columnId: 'amount'})
    }

### BuzzSend   [RESTQuery / REST-WithoutResource] 
    depends on: buzzType.value, buzzSendAction.value === 'send' ?
    0 :
    userIdVar.value, buzzSendAction.value === 'send' ?
    userIdVar.value :
    0, buzzSendType.value, buzzSendAmount.value, buzzSendDescription.value
    https://buzz.civitai.com/transaction

### LogTransaction   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ReToolActions

### transactionTypes   [SqlQuery / Clickhouse] 
    select distinct type from default.buzzTransactions

### UpdateBuzzEligible   [RESTQuery / REST-WithoutResource] 
    depends on: variable1, userId, mode, modId
    https://civitai.com/api/mod/set-rewards-eligibility?token={{variable1}}

### GetPurchases   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT 
      uc."cosmeticId",
      uc."obtainedAt",
      csi."title",
      uc."equippedToType",
      uc."equippedToId",
      csi."unitAmount",
      uc."claimKey"
    FROM "UserCosmetic" uc
    JOIN "CosmeticShopItem" csi ON csi."cosmeticId" = uc."cosmeticId"
    WHERE uc."userId" = {{userIdVar.value}}

### DeleteUserCosmetic   [SqlQueryUnified / Prod] 
    depends on: shopPurchases.selectedRow.claimKey
    DELETE FROM "UserCosmetic" WHERE "claimKey" = {{shopPurchases.selectedRow.claimKey}}

### UpdateShopTransaction   [SqlQueryUnified / Prod] 
    depends on: shopPurchases.selectedRow.claimKey
    UPDATE "UserCosmeticShopPurchases" 
    SET "refunded" = true 
    WHERE "buzzTransactionId" = {{shopPurchases.selectedRow.claimKey}}

### LogShopRefund   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ReToolActions

### TopBuzzKoenQuery   [SqlQuery / Clickhouse] 
    SELECT
        accountId,
        SUM(balance) AS Balance,
        SUM(CASE WHEN earned THEN b.balance ELSE 0 END) AS LifetimeBalance
    FROM (
        -- Earned
         SELECT
             toAccountId AS accountId,
             SUM(amount) AS balance,
             true AS earned
         FROM buzzTransactions
         GROUP BY toAccountId
    
        UNION ALL
    
        -- Spent
        SELECT
            fromAccountId AS accountId,
            -SUM(amount) AS balance,
            false AS earned
         FROM buzzTransactions
         GROUP BY fromAccountId
    ) b
    WHERE "accountId" NOT IN (1, 6, 3, 5, 2, 43555, 18085, 573, 5418, 637525, -100, -101, -102, -103, 0, 13349)
    GROUP BY accountId
    ORDER BY 2 DESC -- ORDER BY 3 for lifetime balance
    LIMIT 200

### GetAccountBuzz   [RESTQuery / REST-WithoutResource] 
    depends on: userIdVar.value
    https://buzz.civitai.com/account/user/{{userIdVar.value}}

### query150   [NoSqlQuery / MongoDB] 
    depends on: textArea4.value.split('\n').map(i => i)
    {"_id": { "$in": {{ textArea4.value.split('\n').map(i => i) }} }}

### SimilarIps   [SqlQuery / Clickhouse - protection disabled] 
    depends on: userIdVar.value
    SELECT * 
    FROM default.userActivities 
    WHERE ip IN (
        {{ formatDataAsArray(RegistrationIP.data)
            .filter(i => i.type === 'Registration' || i.type === 'Subscribe')
            .map(i => `'${i.ip}'`)
            .join(', ') 
        }}
    )
    AND NOT targetUserId = {{ userIdVar.value }}
    ORDER BY time DESC

### ReactionsGrouped   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT
      COUNT(*),
      u."username",
      u."id"
    FROM "ImageReaction" ir
    JOIN "Image" i ON i."id" = ir."imageId"
    JOIN "User" u ON u."id" = i."userId"
    WHERE ir."userId" = {{userIdVar.value}}
    GROUP BY 2,3
    ORDER BY 1 DESC

### ReactionsAll   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT
      *
    FROM "ImageReaction"
    WHERE "userId" = {{userIdVar.value}}

### LogProtectBuzz   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ReToolActions

### LogRemoveBuzz   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ReToolActions

### ActionReport   [RESTQuery / REST-WithoutResource] 
    depends on: variable3, variable0, variable1, variable2
    https://civitai.com/api/mod/action-report?token={{ variable3 }}

### CommentsWithLinks   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT DISTINCT
        c.id as "commentId",
        c."threadId" as "threadId",
        t."commentId" as "parentCommentId",
        c."content",
        c."createdAt",
        c."tosViolation",
        CASE
            WHEN t."imageId" IS NOT NULL THEN 'image'
            WHEN t."modelId" IS NOT NULL THEN 'model'
            WHEN t."postId" IS NOT NULL THEN 'post'
            WHEN t."questionId" IS NOT NULL THEN 'question'
            WHEN t."answerId" IS NOT NULL THEN 'answer'
            WHEN t."reviewId" IS NOT NULL THEN 'review'
            WHEN t."articleId" IS NOT NULL THEN 'article'
            WHEN t."bountyId" IS NOT NULL THEN 'bounty'
            WHEN t."bountyEntryId" IS NOT NULL THEN 'bountyEntry'
            ELSE 'comment'
        END as "commentParentType",
        CASE
            WHEN COALESCE(root."imageId", t."imageId") IS NOT NULL THEN 'image'
            WHEN COALESCE(root."modelId", t."modelId") IS NOT NULL THEN 'model'
            WHEN COALESCE(root."postId", t."postId") IS NOT NULL THEN 'post'
            WHEN COALESCE(root."questionId", t."questionId") IS NOT NULL THEN 'question'
            WHEN COALESCE(root."answerId", t."answerId") IS NOT NULL THEN 'answer'
            WHEN COALESCE(root."reviewId", t."reviewId") IS NOT NULL THEN 'review'
            WHEN COALESCE(root."articleId", t."articleId") IS NOT NULL THEN 'article'
            WHEN COALESCE(root."bountyId", t."bountyId") IS NOT NULL THEN 'bounty'
            WHEN COALESCE(root."bountyEntryId", t."bountyEntryId") IS NOT NULL THEN 'bountyEntry'
            ELSE 'comment'
        END as "entityType",
        COALESCE(
            root."imageId",
            root."modelId",
            root."postId",
            root."questionId",
            root."answerId",
            root."reviewId",
            root."articleId",
            root."bountyId",
            root."bountyEntryId",
            t."imageId",
            t."modelId",
            t."postId",
            t."questionId",
            t."answerId",
            t."reviewId",
            t."articleId",
            t."bountyId",
            t."bountyEntryId"
        ) as "entityId"
    FROM "CommentV2" c
    LEFT JOIN "Thread" t ON t.id = c."threadId"
    LEFT JOIN "Thread" root ON root.id = t."rootThreadId"
    LEFT JOIN "CommentV2" pc ON pc.id = t."commentId"
    WHERE c."userId" = {{ userIdVar.value }}
    ORDER BY c."createdAt" DESC;

### SendNotification   [RESTQuery / REST-WithoutResource] 
    depends on: token, key, userId, type, details, category
    https://civitai.com/api/mod/send-mod-notification?token={{ token }}

### LogModActivity   [SqlQueryUnified / Prod] 
    depends on: current_user.metadata.userIdCivit, userIdVar.value
    INSERT INTO "ModActivity"("userId", activity, "entityType", "entityId", "createdAt")
    VALUES ({{current_user.metadata.userIdCivit}},
        'nsfwPurge',
        'user',
        {{ userIdVar.value }} ,
        now())
    ON CONFLICT (activity, "entityType", "entityId") DO UPDATE SET "createdAt" = now();

### LogRemovePG13   [SqlQueryUnified / retool_db] 
    GUI-mode write → table: ReToolActions

### GetSuccesfulPromptsUpdated   [NoSqlQuery / MongoDB] 
    depends on: userIdVar.value
    {"_id": { "$regex": "^{{userIdVar.value}}-" } }

### SocialScore   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT
        (meta->'scores'->>'total')::int AS total,
        (meta->'scores'->>'users')::int AS users,
        (meta->'scores'->>'images')::int AS images,
        (meta->'scores'->>'models')::int AS models,
        (meta->'scores'->>'articles')::int AS articles,
        (meta->'scores'->>'reportsAgainst')::int AS reports_against,
        (meta->'scores'->>'reportsActioned')::int AS reports_actioned
    FROM "User"
    WHERE id = {{ userIdVar.value }}

### GetGenBuzz   [RESTQuery / REST-WithoutResource] 
    depends on: userIdVar.value
    https://buzz.civitai.com/account/generation/{{userIdVar.value}}

### GetNotifications   [SqlQueryUnified / Notifications DB] 
    depends on: userIdVar.value
    SELECT * FROM "UserNotification" WHERE "userId" = {{ userIdVar.value }} ORDER BY "createdAt" DESC

### ViewNotifications   [SqlQueryUnified / Notifications DB] 
    depends on: userIdVar.value, textInput16.value
    SELECT un.*, n.*
    FROM "UserNotification" un
    JOIN "Notification" n ON n.id = un."notificationId"
    WHERE "userId" = {{ userIdVar.value }}
    ORDER BY un."createdAt" DESC
    LIMIT {{ textInput16.value }}

### BuzzTransferPopulate   [JavascriptQuery / JavascriptQuery] 
    buzzSendAction.setValue(action)
    buzzSendType.setValue(reason)
    buzzType.setValue(buzztype)
    buzzSendAmount.setValue(amount)
    buzzSendDescription.setValue(description)

### TopBuzzUsernames   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: TopBuzzKoenQuery.data.accountId
    SELECT id, username
    FROM "User"
    WHERE id = ANY({{ TopBuzzKoenQuery.data.accountId }})

### BANAPINOREASON   [RESTQuery / REST-WithoutResource] 
    depends on: UserContent.data.id, retoolContext.configVars.WEBHOOK_TOKEN
    https://www.civitai.com/api/mod/ban-user?userId={{UserContent.data.id}}&token={{ retoolContext.configVars.WEBHOOK_TOKEN}}

### darkmode   [JavascriptQuery / JavascriptQuery] 
    inverter.setValue(darkModeSwitch.value ? 1 : 0);

### enableedit   [JavascriptQuery / JavascriptQuery] 
    enableEdits.setValue(enableEditsSwitch.value ? 0 : 1);

### ModelCountsUnion   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    WITH ModelCounts AS (
        SELECT 
            COUNT(*) AS "Total",
            SUM(CASE WHEN "Model"."nsfw" = true THEN 1 ELSE 0 END) AS "NSFW",
            SUM(CASE WHEN "Model"."tosViolation" = true THEN 1 ELSE 0 END) AS "TOS",
            SUM(CASE WHEN "Model"."poi" = true THEN 1 ELSE 0 END) AS "POI",
            SUM(CASE WHEN "Model"."locked" = true THEN 1 ELSE 0 END) AS "Locked",
            SUM(CASE WHEN "Model"."deletedAt" IS NOT NULL THEN 1 ELSE 0 END) AS "Deleted"
        FROM 
            "Model" 
        WHERE "Model"."userId" = {{ userIdVar.value }}
    ),
    UserStats AS (
        SELECT 
            "downloadCountAllTime", 
            ROUND("ratingAllTime"::numeric, 2) AS "ratingAllTime"
        FROM 
            "UserStat"
        WHERE 
            "UserStat"."userId" = {{ userIdVar.value }}
    )
    SELECT 
        'Total' AS "Content", "Total" AS "Count"
    FROM 
        ModelCounts
    
    UNION ALL
    
    SELECT 
        'NSFW' AS "Content", "NSFW" AS "Count"
    FROM 
        ModelCounts
    
    UNION ALL
    
    SELECT 
        'TOS' AS "Content", "TOS" AS "Count"
    FROM 
        ModelCounts
    
    UNION ALL
    
    SELECT 
        'POI' AS "Content", "POI" AS "Count"
    FROM 
        ModelCounts
    
    UNION ALL
    
    SELECT 
        'Locked' AS "Content", "Locked" AS "Count"
    FROM 
        ModelCounts
    
    UNION ALL
    
    SELECT 
        'Deleted' AS "Content", "Deleted" AS "Count"
    FROM 
        ModelCounts
    
    UNION ALL
    
    SELECT 
        'Downloads' AS "Content", "downloadCountAllTime" AS "Count"
    FROM 
        UserStats
    
    UNION ALL
    
    SELECT 
        'Rating' AS "Content", "ratingAllTime" AS "Count"
    FROM 
        UserStats;

### FollowerCountUnion   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    WITH UserStats AS (
        SELECT 
            "followerCountAllTime", 
            "followingCountAllTime"
        FROM 
            "UserStat"
        WHERE 
            "UserStat"."userId" = {{ userIdVar.value }}
    )
    SELECT 
        'Followers' AS "Content", "followerCountAllTime" AS "Count"
    FROM 
        UserStats
    
    UNION ALL
    
    SELECT 
        'Following' AS "Content", "followingCountAllTime" AS "Count"
    FROM 
        UserStats;

### ReportedCountUnion   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    WITH ReportedComments AS (
        SELECT COUNT(1) AS "reportedCommentCount"
        FROM "Comment" 
        LEFT JOIN "CommentReport" ON "Comment"."id" = "CommentReport"."commentId"
        LEFT JOIN "Report" ON "CommentReport"."reportId" = "Report"."id"
        LEFT JOIN "User" "reportedBy" ON "Report"."userId" = "reportedBy"."id"
        WHERE "Comment"."userId" = {{ userIdVar.value }}
        AND "CommentReport"."reportId" IS NOT NULL
    ),
    ReportedImages AS (
        SELECT COUNT("Image"."id") AS "reportedImageCount"
        FROM "Image" 
        LEFT JOIN "ImageReport" ON "Image"."id" = "ImageReport"."imageId"
        LEFT JOIN "Report" ON "ImageReport"."reportId" = "Report"."id"
        LEFT JOIN "User" "reportedBy" ON "Report"."userId" = "reportedBy"."id"
        WHERE "Image"."userId" = {{ userIdVar.value }}
        AND "ImageReport"."reportId" IS NOT NULL
    ),
    ReportedModels AS (
        SELECT COUNT("Model"."id") AS "reportedModelCount"
        FROM "Model" 
        LEFT JOIN "ModelReport" ON "Model"."id" = "ModelReport"."modelId"
        LEFT JOIN "Report" ON "ModelReport"."reportId" = "Report"."id"
        LEFT JOIN "User" "reportedBy" ON "Report"."userId" = "reportedBy"."id"
        WHERE "Model"."userId" = {{ userIdVar.value }}
        AND "ModelReport"."reportId" IS NOT NULL
    )
    SELECT 
        'Reported Comments' AS "Content", "reportedCommentCount" AS "Count"
    FROM 
        ReportedComments
    
    UNION ALL
    
    SELECT 
        'Reported Images' AS "Content", "reportedImageCount" AS "Count"
    FROM 
        ReportedImages
    
    UNION ALL
    
    SELECT 
        'Reported Models' AS "Content", "reportedModelCount" AS "Count"
    FROM 
        ReportedModels;

### ReportsSubmittedUnion   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    WITH ReportCounts AS (
        SELECT 
            COUNT(*) AS "Total",
            SUM(CASE WHEN "Report"."status" = 'Actioned' THEN 1 ELSE 0 END) AS "ActionedCount",
            SUM(CASE WHEN "Report"."status" = 'Unactioned' THEN 1 ELSE 0 END) AS "UnactionedCount",
            SUM(CASE WHEN "Report"."status" = 'Pending' THEN 1 ELSE 0 END) AS "PendingCount"
        FROM "Report"
        WHERE "Report"."userId" = {{ userIdVar.value }}
    )
    SELECT 
        'Total Reports' AS "Content", "Total" AS "Count"
    FROM 
        ReportCounts
    
    UNION ALL
    
    SELECT 
        'Actioned' AS "Content", "ActionedCount" AS "Count"
    FROM 
        ReportCounts
    
    UNION ALL
    
    SELECT 
        'Unactioned' AS "Content", "UnactionedCount" AS "Count"
    FROM 
        ReportCounts
    
    UNION ALL
    
    SELECT 
        'Pending' AS "Content", "PendingCount" AS "Count"
    FROM 
        ReportCounts
    
    UNION ALL
    
    SELECT 
        'Actioned %' AS "Content", 
        CASE WHEN "Total" > 0 THEN ROUND(("ActionedCount"::numeric / "Total"::numeric) * 100, 2) ELSE 0 END AS "Count"
    FROM 
        ReportCounts
    
    UNION ALL
    
    SELECT 
        'Unactioned %' AS "Content", 
        CASE WHEN "Total" > 0 THEN ROUND(("UnactionedCount"::numeric / "Total"::numeric) * 100, 2) ELSE 0 END AS "Count"
    FROM 
        ReportCounts;

### NewSubmittedTrainsBrett   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT
        "ModelFile".*,
        "ModelFile".id::int,
        username,
        email,
        "User"."id" AS userId,
        "User"."isModerator",
        "User"."subscriptionId",
        "modelId",
        'https://civitai.com/models/' || "modelId" AS modelUrl,
        'https://civitai.com/api/download/models/' || "modelId" || '?type=Model&format=SafeTensor' as modelDownloadUrl,
        "modelVersionId",
        "trainingDetails"::json ->> 'baseModel' as baseModel,
        COALESCE("ModelFile"."metadata"::json -> 'trainingResults' ->> 'workflowId', "ModelFile"."metadata"::json -> 'trainingResults' ->> 'jobId') workflow_or_jobId,
        coalesce(
      (select string_agg(
                concat(
                  'Amount: ', x.val ->> 'amount', 
                  ', Color: ', 
                  case 
                    when x.val ->> 'accountType' = 'user' then 'Yellow' 
                    when x.val ->> 'accountType' = 'generation' then 'Blue' 
                    else x.val ->> 'accountType'  -- Default to actual accountType if not user or generation
                  end
                ), '; ')
       from jsonb_array_elements("ModelFile"."metadata"::jsonb -> 'trainingResults' -> 'transactionData') as x(val)
       where x.val ->> 'type' = 'credit' -- Filter only credit types
      ),
      "ModelFile"."metadata"::jsonb -> 'trainingResults' ->> 'transactionId'
    ) as transactionDetails,
        "ModelVersion".name,
        "trainingStatus"::varchar,
        ("ModelFile"."metadata"::json ->> 'numImages')::int as num_images,
        ("ModelFile"."metadata"::json ->> 'shareDataset')::TEXT as share_dataset,
        COALESCE("ModelFile"."metadata"::json -> 'trainingResults' -> 'epochs' -> -1 ->> 'modelUrl', "ModelFile"."metadata"::json -> 'trainingResults' -> 'epochs' -> -1 ->> 'model_url') as last_epoch_model_url,
        json_array_length("ModelFile"."metadata"::json -> 'trainingResults' -> 'epochs') as "current_epoch",
        "ModelVersion"."trainingDetails"::json ->> 'type' as "type",
        "ModelVersion"."trainingDetails"::json -> 'params' ->> 'trainBatchSize' as "train_batch_size",
        "ModelVersion"."trainingDetails"::json -> 'params' ->> 'maxTrainEpochs' as "max_train_epochs",
        "ModelVersion"."trainingDetails"::json -> 'params' ->> 'resolution' as "resolution",
        "ModelVersion"."trainingDetails"::json -> 'params' ->> 'targetSteps' as "target_steps",
        "ModelVersion"."trainingDetails"::json -> 'params' ->> 'networkAlpha' as "target_alpha",
        "ModelVersion"."trainingDetails"::json -> 'params' ->> 'networkDim' as "target_dim",
        "ModelVersion"."trainingDetails"::json -> 'params' ->> 'textEncoderLR' as "text_encoder_lr",
        "ModelVersion"."trainingDetails"::json -> 'params' ->> 'unetLR' as "unet_lr",
        "ModelVersion"."trainingDetails"::json -> 'params' ->> 'lrScheduler' as "lrScheduler",
        coalesce("ModelFile".metadata::json -> 'trainingResults' ->> 'startedAt', "ModelFile".metadata::json -> 'trainingResults' ->> 'start_time') as start_time,
        coalesce("ModelFile".metadata::json -> 'trainingResults' ->> 'completedAt', "ModelFile".metadata::json -> 'trainingResults' ->> 'end_time') as end_time
    --     CASE
    --       WHEN ("ModelFile".metadata::json -> 'trainingResults' ->> 'end_time') IS NOT NULL AND ("ModelFile".metadata::json -> 'trainingResults' ->> 'start_time') IS NOT NULL THEN
    --         (("ModelFile".metadata::json -> 'trainingResults' -> 'end_time')::TEXT)::TIMESTAMP - (("ModelFile".metadata::json -> 'trainingResults' -> 'start_time')::TEXT)::TIMESTAMP
    --       ELSE NULL
    --     END as duration, -- idk, we can do this later
    FROM "Model"
             JOIN "ModelVersion"
                  ON "Model".id = "ModelVersion"."modelId"
             JOIN "User" ON "Model"."userId" = "User".id
             LEFT JOIN "ModelFile" ON "ModelFile"."modelVersionId" = "ModelVersion".id
    WHERE "ModelVersion"."uploadType" = 'Trained'
      AND ("ModelFile".type = 'Training Data' OR "ModelFile".type IS NULL)
    AND "User"."id" =  {{userIdVar.value}}
    order by "ModelFile"."id" desc;

### FindPreviousBans   [SqlQuery / Clickhouse - protection disabled] 
    depends on: SimilarIps.data.targetUserId
    SELECT * 
    FROM default.userActivities 
    WHERE "type" IN('Banned', 'Muted')
    AND targetUserId IN({{ SimilarIps.data.targetUserId }})
    ORDER BY type

### SimilarIpStrikes   [SqlQueryUnified / retool_db] 
    depends on: SimilarIps.data.targetUserId
    SELECT 
      'Strike' AS type,
      "createdAt" AS time,
      "userId" AS "targetUserId",
      "createdBy" AS "userId"
    FROM "UserStrikes" WHERE "userId" = ANY({{ SimilarIps.data.targetUserId }})

### CuratorStatus2   [SqlQueryUnified / Replicated_Read_Prod] 
    SELECT distinct permissions
    FROM "CollectionContributor"
    WHERE "collectionId" IN (104, 105, 106, 107)

### WarrantChatLog   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT
      cm."createdAt",
      cm."chatId",
      cm."content",
      sender.id        AS sender_id,
      sender.username  AS sender_username,
      receiver.id      AS receiver_id,
      receiver.username AS receiver_username,
      CASE WHEN cm."userId" = {{userIdVar.value}} THEN 'sent' ELSE 'received' END AS direction
    FROM "ChatMessage" cm
    JOIN "User" sender
      ON sender.id = cm."userId"
    JOIN "ChatMember" cmm_other
      ON cmm_other."chatId" = cm."chatId"
     AND cmm_other."userId" <> cm."userId"
    JOIN "User" receiver
      ON receiver.id = cmm_other."userId"
    WHERE EXISTS (
      SELECT 1
      FROM "ChatMember" me
      WHERE me."chatId" = cm."chatId"
        AND me."userId" = {{userIdVar.value}}
    )
    ORDER BY cm."createdAt" DESC;

### GetGreenBuzz   [RESTQuery / REST-WithoutResource] 
    depends on: userIdVar.value
    https://buzz.civitai.com/account/green/{{userIdVar.value}}

### ClearCache   [RESTQuery / REST-WithoutResource] 
    depends on: userIdVar.value, retoolContext.configVars.WEBHOOK_TOKEN
    https://www.civitai.com/api/mod/reset-user-subscription-caches?userId={{ userIdVar.value }}&token={{ retoolContext.configVars.WEBHOOK_TOKEN }}

### query152   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT
      r.*,
      rr."chatId" AS entityId,
      'ChatMessage' AS entityType,
      concat('https://civitai.com/reviews/') AS link,
      umod."username" AS statusSetByUsername
    FROM
      "Report" r
      LEFT JOIN "ChatReport" rr ON r."id" = rr."reportId"
      LEFT JOIN "ChatMessage" cm ON cm."chatId" = rr."chatId"
      LEFT JOIN "User" umod ON r."statusSetBy" = umod."id"
    WHERE
      cm."userId" = {{userIdVar.value}}
    AND reason != 'Automated'
    ORDER BY r."createdAt" DESC
    LIMIT 10

### MuteStatus   [SqlQueryUnified / Replicated_Read_Prod] 
    depends on: userIdVar.value
    SELECT ur.*, u.username  FROM "UserRestriction" ur
    LEFT JOIN "User" u ON u.id = ur."resolvedBy"
    WHERE "userId" = {{ userIdVar.value }}
    ORDER BY id DESC

### DeleteComments   [RESTQuery / REST-WithoutResource] 
    depends on: CombinedComments.selectedRows.filter((i) => i.Source === 'Comment').map((j) => j.id), CombinedComments.selectedRows.filter((i) => i.Source === 'CommentV2').map((j) => j.id)
    https://civitai.com/api/mod/retool/comment

### ToSComments   [RESTQuery / REST-WithoutResource] 
    depends on: CombinedComments.selectedRows.filter((i) => i.Source === 'Comment').map((j) => j.id), CombinedComments.selectedRows.filter((i) => i.Source === 'CommentV2').map((j) => j.id)
    https://civitai.com/api/mod/retool/comment

### ExcludeOrIncludeReview   [RESTQuery / REST-WithoutResource] 
    depends on: reviews.selectedRowKeys, exclude
    https://civitai.com/api/mod/retool/review

### ForceLogout   [RESTQuery / REST-WithoutResource] 
    depends on: userIdVar.value
    https://civitai.com/api/mod/retool/user

### query153   [SqlQueryUnified / Replicated_Read_Prod] 
    select * from "UserReport" ur join "Report" r on r."id" = ur."reportId" where ur."userId" = 12365791
