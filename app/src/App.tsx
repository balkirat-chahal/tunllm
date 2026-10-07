import { useEffect, useRef, useState, type FormEvent } from "react";
import { MessageSquareIcon, SendIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useDesktopChat, type ChatStatus } from "@/hooks/use-desktop-chat";

const statusLabel: Record<ChatStatus, string> = {
  connecting: "Connecting",
  waiting: "Waiting for desktop",
  connected: "Live",
  error: "Reconnecting",
};

const statusVariant: Record<ChatStatus, "outline" | "secondary" | "default" | "destructive"> = {
  connecting: "outline",
  waiting: "secondary",
  connected: "default",
  error: "destructive",
};

export function App() {
  const { status, messages, pending, sendMessage } = useDesktopChat();
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const connected = status === "connected";

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pending]);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || pending || !connected) return;
    if (sendMessage(content)) setDraft("");
  }

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-lg flex-col p-4">
      <Card className="flex min-h-0 flex-1 flex-col">
        <CardHeader className="border-b">
          <CardTitle>TunLLM</CardTitle>
          <CardDescription>Talk to the desktop Ollama over WebRTC.</CardDescription>
          <CardAction>
            <Badge variant={statusVariant[status]}>{statusLabel[status]}</Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 px-0">
          <ScrollArea className="h-full">
            <div className="flex flex-col gap-3 p-4">
              {messages.length === 0 && !pending ? (
                <Empty className="border">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <MessageSquareIcon />
                    </EmptyMedia>
                    <EmptyTitle>No messages yet</EmptyTitle>
                    <EmptyDescription>
                      {connected
                        ? "Send a message and the desktop will answer with a full Ollama response."
                        : "Start the desktop client, then this phone app will connect."}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : null}
              {messages.map((line) => (
                <div
                  key={line.id}
                  className={cn("flex", line.role === "user" ? "justify-end" : "justify-start")}
                >
                  <div
                    className={cn(
                      "max-w-[85%] rounded-lg px-3 py-2",
                      line.role === "user" && "bg-primary text-primary-foreground",
                      line.role === "assistant" && "bg-muted text-foreground",
                      line.role === "error" && "bg-destructive/10 text-destructive",
                    )}
                  >
                    {line.content}
                  </div>
                </div>
              ))}
              {pending ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner />
                  Waiting for desktop
                </div>
              ) : null}
              <div ref={bottomRef} />
            </div>
          </ScrollArea>
        </CardContent>
        <CardFooter>
          <form className="w-full" onSubmit={onSubmit}>
            <FieldGroup>
              <Field data-disabled={!connected || pending || undefined}>
                <FieldLabel htmlFor="message" className="sr-only">
                  Message
                </FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="message"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || event.shiftKey) return;
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }}
                    placeholder={connected ? "Message" : "Waiting for desktop"}
                    disabled={!connected || pending}
                    autoComplete="off"
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton type="submit" disabled={!connected || pending || !draft.trim()}>
                      {pending ? <Spinner data-icon="inline-start" /> : <SendIcon data-icon="inline-start" />}
                      Send
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </Field>
            </FieldGroup>
          </form>
        </CardFooter>
      </Card>
    </div>
  );
}

export default App;
