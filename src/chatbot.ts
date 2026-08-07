export type ChatMessage = Readonly<{
  id: string;
  channelId: string;
  senderId: string;
  senderName: string;
  text: string;
}>;

export interface Chatbot {
  messages(): AsyncIterable<ChatMessage>;
  sendMessage(text: string, replyToMessageId?: string): Promise<string>;
  close(): void;
}
