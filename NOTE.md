# What I did not finish, and why

**Not built**
* **Holidays UI.** The API (`/api/holidays`) works and the engine honours it, but there is no screen. The seeded dates are placeholders.
* **Email.** No email is sent to customers or agents; customers use the private link. A real system would send notifications when an agent replies.
* **Customer identity.** Anyone with the ticket link can act as the customer. No login, no email verification.
* **Notifications for approaching deadlines.** The queue shows late/not-late, but there is no "due in 30 minutes" warning.
* **Waiting time** The waiting time for a customer's reply must be checked manually by the agent before sending a message.It is not paused automatically.
* **Priority changed mid-way (Meera's open question).** Working time already elapsed is kept; the new priority's targets are applied to the same clock. Raising to urgent can make a ticket late immediately; lowering can bring it back on time. Every change is audited with the before/after deadlines. (Alternative: restart the clock. I rejected it because it lets an agent erase lateness by toggling priority.)
* **Private Notes** Private team notes have been kept private but they have not been organised properly.
