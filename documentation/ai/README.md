# The assistant

Two documents, for two different readers.

| | For | Read it to answer |
|---|---|---|
| **[how-it-works.md](how-it-works.md)** | Anyone who runs n8n and uses the dashboard. No code. | *What can I ask it? Why did it say that? Should I believe this number?* |
| **[developers.md](developers.md)** | Anyone changing it. | *Where does a turn go? How do I add an analysis? What stops it reading customer data?* |

They overlap on purpose in one place — the reason the assistant cannot invent
a number is the same reason it sometimes says "I cannot answer that", and both
readers need it. It is stated plainly in the first and mechanically in the
second.

If you only read one paragraph: the model does not write queries. It picks from
a fixed list of analyses that already exist in this codebase and are the same
ones the dashboard's own pages are drawn from. That single decision is where
almost every property in both documents comes from.
