## This is a LLM word vector similarity sorter on topics bot.

### Consists of:

- llama.cpp LLM classifier, topic namegiver
- reynkonig's [embedding word vector generator](https://github.com/reynkonig/embedding-server.git)
- webpage to view resulted topics and control the bot

### For each new message:

1. Generate normalized embedding V.
2. Compare V with every active topic centroid.
3. Select the topic with the highest cosine similarity.
4. If similarity >= threshold:
     add message to topic
     vector_sum += V
     centroid = normalize(vector_sum)
     message_count += 1
   Else:
     create a candidate topic centered on V
5. When candidate reaches 5 messages:
   generate a name from its sample messages
6. Delete candidate if it remains below 5 after 50 subsequent messages.
7. Retire confirmed topics after they have been inactive for a suitable window.
