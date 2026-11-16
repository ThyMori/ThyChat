// Types de la base, GÉNÉRÉS à partir de supabase/schema.sql — ne pas modifier à la main.
// Pour les mettre à jour : python3 scripts/gen-db-types.py (puis commit). Nécessite : pip install pglast

import type { Attachment } from "./types.js";

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: {
      access_requests: {
        Row: {
          id: string;
          name: string;
          email: string;
          production: string;
          mail_sent: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          email: string;
          production: string;
          mail_sent?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          email?: string;
          production?: string;
          mail_sent?: boolean;
          created_at?: string;
        };
        Relationships: [
        ];
      };
      app_settings: {
        Row: {
          key: string;
          value: string;
        };
        Insert: {
          key: string;
          value: string;
        };
        Update: {
          key?: string;
          value?: string;
        };
        Relationships: [
        ];
      };
      channel_members: {
        Row: {
          channel_id: string;
          user_id: string;
          created_at: string;
        };
        Insert: {
          channel_id: string;
          user_id: string;
          created_at?: string;
        };
        Update: {
          channel_id?: string;
          user_id?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "channel_members_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
        ];
      };
      channel_reads: {
        Row: {
          user_id: string;
          channel_id: string;
          last_read_at: string;
        };
        Insert: {
          user_id?: string;
          channel_id: string;
          last_read_at?: string;
        };
        Update: {
          user_id?: string;
          channel_id?: string;
          last_read_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "channel_reads_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
        ];
      };
      channels: {
        Row: {
          id: string;
          workspace_id: string;
          name: string;
          description: string | null;
          created_at: string;
          kind: ("channel" | "dm" | "notes");
          everyone: boolean;
          room_id: string | null;
          owner_id: string | null;
          created_by: string | null;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          name: string;
          description?: string | null;
          created_at?: string;
          kind?: ("channel" | "dm" | "notes");
          everyone?: boolean;
          room_id?: string | null;
          owner_id?: string | null;
          created_by?: string | null;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          name?: string;
          description?: string | null;
          created_at?: string;
          kind?: ("channel" | "dm" | "notes");
          everyone?: boolean;
          room_id?: string | null;
          owner_id?: string | null;
          created_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "channels_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "channels_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
        ];
      };
      message_pins: {
        Row: {
          message_id: string;
          channel_id: string;
          pinned_by: string;
          pinned_at: string;
          expires_at: string;
        };
        Insert: {
          message_id: string;
          channel_id: string;
          pinned_by?: string;
          pinned_at?: string;
          expires_at: string;
        };
        Update: {
          message_id?: string;
          channel_id?: string;
          pinned_by?: string;
          pinned_at?: string;
          expires_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "message_pins_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "message_pins_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
        ];
      };
      messages: {
        Row: {
          id: string;
          channel_id: string;
          user_id: string;
          parent_id: string | null;
          body: string;
          pinned: boolean;
          attachments: Attachment[];
          created_at: string;
          edited_at: string | null;
          reply_to: string | null;
          tag_ids: string[];
          struck_at: string | null;
        };
        Insert: {
          id?: string;
          channel_id: string;
          user_id?: string;
          parent_id?: string | null;
          body: string;
          pinned?: boolean;
          attachments?: Attachment[];
          created_at?: string;
          edited_at?: string | null;
          reply_to?: string | null;
          tag_ids?: string[];
          struck_at?: string | null;
        };
        Update: {
          id?: string;
          channel_id?: string;
          user_id?: string;
          parent_id?: string | null;
          body?: string;
          pinned?: boolean;
          attachments?: Attachment[];
          created_at?: string;
          edited_at?: string | null;
          reply_to?: string | null;
          tag_ids?: string[];
          struck_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "messages_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_parent_id_fkey";
            columns: ["parent_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_reply_to_fkey";
            columns: ["reply_to"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
        ];
      };
      notification_mutes: {
        Row: {
          user_id: string;
          scope: ("workspace" | "room" | "channel");
          target_id: string;
          muted_until: string | null;
          forever: boolean;
          created_at: string;
        };
        Insert: {
          user_id?: string;
          scope: ("workspace" | "room" | "channel");
          target_id: string;
          muted_until?: string | null;
          forever?: boolean;
          created_at?: string;
        };
        Update: {
          user_id?: string;
          scope?: ("workspace" | "room" | "channel");
          target_id?: string;
          muted_until?: string | null;
          forever?: boolean;
          created_at?: string;
        };
        Relationships: [
        ];
      };
      postit_states: {
        Row: {
          postit_id: string;
          user_id: string;
          state: ("discarded" | "purged");
          updated_at: string;
        };
        Insert: {
          postit_id: string;
          user_id?: string;
          state: ("discarded" | "purged");
          updated_at?: string;
        };
        Update: {
          postit_id?: string;
          user_id?: string;
          state?: ("discarded" | "purged");
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "postit_states_postit_id_fkey";
            columns: ["postit_id"];
            isOneToOne: false;
            referencedRelation: "postits";
            referencedColumns: ["id"];
          },
        ];
      };
      postits: {
        Row: {
          id: string;
          channel_id: string;
          user_id: string;
          body: string;
          created_at: string;
          kind: ("note" | "todo");
          items: Json | null;
        };
        Insert: {
          id?: string;
          channel_id: string;
          user_id?: string;
          body: string;
          created_at?: string;
          kind?: ("note" | "todo");
          items?: Json | null;
        };
        Update: {
          id?: string;
          channel_id?: string;
          user_id?: string;
          body?: string;
          created_at?: string;
          kind?: ("note" | "todo");
          items?: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "postits_channel_id_fkey";
            columns: ["channel_id"];
            isOneToOne: false;
            referencedRelation: "channels";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: {
          id: string;
          display_name: string;
          avatar_url: string | null;
          created_at: string;
          is_super_admin: boolean;
        };
        Insert: {
          id: string;
          display_name?: string;
          avatar_url?: string | null;
          created_at?: string;
          is_super_admin?: boolean;
        };
        Update: {
          id?: string;
          display_name?: string;
          avatar_url?: string | null;
          created_at?: string;
          is_super_admin?: boolean;
        };
        Relationships: [
        ];
      };
      push_subscriptions: {
        Row: {
          id: string;
          user_id: string;
          endpoint: string;
          p256dh: string;
          auth: string;
          user_agent: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          endpoint: string;
          p256dh: string;
          auth: string;
          user_agent?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          endpoint?: string;
          p256dh?: string;
          auth?: string;
          user_agent?: string | null;
          created_at?: string;
        };
        Relationships: [
        ];
      };
      room_members: {
        Row: {
          room_id: string;
          user_id: string;
          created_at: string;
        };
        Insert: {
          room_id: string;
          user_id: string;
          created_at?: string;
        };
        Update: {
          room_id?: string;
          user_id?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "room_members_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
        ];
      };
      room_sheets: {
        Row: {
          id: string;
          room_id: string;
          name: string;
          path: string | null;
          version_date: string;
          size_bytes: number | null;
          created_by: string | null;
          created_at: string;
          kind: string;
          url: string | null;
        };
        Insert: {
          id?: string;
          room_id: string;
          name: string;
          path?: string | null;
          version_date?: string;
          size_bytes?: number | null;
          created_by?: string | null;
          created_at?: string;
          kind?: string;
          url?: string | null;
        };
        Update: {
          id?: string;
          room_id?: string;
          name?: string;
          path?: string | null;
          version_date?: string;
          size_bytes?: number | null;
          created_by?: string | null;
          created_at?: string;
          kind?: string;
          url?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "room_sheets_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
        ];
      };
      room_staff: {
        Row: {
          room_id: string;
          user_id: string;
          functions: (("technique" | "prod" | "rg")[]);
          sheet_read: boolean;
        };
        Insert: {
          room_id: string;
          user_id: string;
          functions?: (("technique" | "prod" | "rg")[]);
          sheet_read?: boolean;
        };
        Update: {
          room_id?: string;
          user_id?: string;
          functions?: (("technique" | "prod" | "rg")[]);
          sheet_read?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "room_staff_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
        ];
      };
      rooms: {
        Row: {
          id: string;
          workspace_id: string;
          name: string;
          description: string | null;
          everyone: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          name: string;
          description?: string | null;
          everyone?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          name?: string;
          description?: string | null;
          everyone?: boolean;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "rooms_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      tag_documents: {
        Row: {
          id: string;
          tag_id: string;
          name: string;
          path: string | null;
          size_bytes: number | null;
          created_by: string | null;
          created_at: string;
          kind: string;
          url: string | null;
        };
        Insert: {
          id?: string;
          tag_id: string;
          name: string;
          path?: string | null;
          size_bytes?: number | null;
          created_by?: string | null;
          created_at?: string;
          kind?: string;
          url?: string | null;
        };
        Update: {
          id?: string;
          tag_id?: string;
          name?: string;
          path?: string | null;
          size_bytes?: number | null;
          created_by?: string | null;
          created_at?: string;
          kind?: string;
          url?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "tag_documents_tag_id_fkey";
            columns: ["tag_id"];
            isOneToOne: false;
            referencedRelation: "tour_tags";
            referencedColumns: ["id"];
          },
        ];
      };
      tour_tags: {
        Row: {
          id: string;
          room_id: string;
          label: string;
          on_date: string | null;
          created_at: string;
          start_date: string | null;
          end_date: string | null;
          shows: string[];
        };
        Insert: {
          id?: string;
          room_id: string;
          label: string;
          on_date?: string | null;
          created_at?: string;
          start_date?: string | null;
          end_date?: string | null;
          shows?: string[];
        };
        Update: {
          id?: string;
          room_id?: string;
          label?: string;
          on_date?: string | null;
          created_at?: string;
          start_date?: string | null;
          end_date?: string | null;
          shows?: string[];
        };
        Relationships: [
          {
            foreignKeyName: "tour_tags_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
        ];
      };
      workspace_members: {
        Row: {
          workspace_id: string;
          user_id: string;
          role: ("admin" | "member");
          created_at: string;
          support: boolean;
        };
        Insert: {
          workspace_id: string;
          user_id: string;
          role?: ("admin" | "member");
          created_at?: string;
          support?: boolean;
        };
        Update: {
          workspace_id?: string;
          user_id?: string;
          role?: ("admin" | "member");
          created_at?: string;
          support?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "workspace_members_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      workspaces: {
        Row: {
          id: string;
          name: string;
          created_by: string;
          created_at: string;
          theme: string | null;
          avatar_url: string | null;
        };
        Insert: {
          id?: string;
          name: string;
          created_by?: string;
          created_at?: string;
          theme?: string | null;
          avatar_url?: string | null;
        };
        Update: {
          id?: string;
          name?: string;
          created_by?: string;
          created_at?: string;
          theme?: string | null;
          avatar_url?: string | null;
        };
        Relationships: [
        ];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      add_member_by_email: { Args: { ws: string; member_email: string; member_role?: string }; Returns: undefined };
      can_access_channel: { Args: { ch: string }; Returns: boolean };
      can_access_channel_as: { Args: { uid: string; ch: string }; Returns: boolean };
      can_access_room: { Args: { rm: string }; Returns: boolean };
      can_access_room_as: { Args: { uid: string; rm: string }; Returns: boolean };
      can_assign_room: { Args: { rm: string }; Returns: boolean };
      can_edit_roadmap: { Args: { rm: string }; Returns: boolean };
      can_edit_sheet: { Args: { rm: string }; Returns: boolean };
      can_manage_channel: { Args: { ch: string }; Returns: boolean };
      can_moderate_channel: { Args: { ch: string }; Returns: boolean };
      can_moderate_room: { Args: { rm: string }; Returns: boolean };
      can_read_sheet: { Args: { rm: string }; Returns: boolean };
      channel_room: { Args: { ch: string }; Returns: string };
      channel_workspace: { Args: { ch: string }; Returns: string };
      is_super_admin: { Args: Record<PropertyKey, never>; Returns: boolean };
      is_super_as: { Args: { uid: string }; Returns: boolean };
      is_workspace_admin: { Args: { ws: string }; Returns: boolean };
      is_workspace_member: { Args: { ws: string }; Returns: boolean };
      join_workspace_as_support: { Args: { ws: string }; Returns: undefined };
      mark_channel_read: { Args: { ch: string }; Returns: undefined };
      move_message: { Args: { msg: string; target: string }; Returns: undefined };
      my_notes_usage: { Args: Record<PropertyKey, never>; Returns: { photo_bytes: number; items: number; photo_limit: number; item_limit: number }[] };
      my_unread_counts: { Args: Record<PropertyKey, never>; Returns: { channel_id: string; workspace_id: string; unread: number }[] };
      notes_can_upload: { Args: { ch: string }; Returns: boolean };
      notes_item_limit: { Args: Record<PropertyKey, never>; Returns: number };
      notes_photo_limit: { Args: Record<PropertyKey, never>; Returns: number };
      notes_usage_as: { Args: { uid: string }; Returns: { photo_bytes: number; items: number; photo_limit: number; item_limit: number }[] };
      open_dm: { Args: { ws: string; other: string }; Returns: string };
      open_notes: { Args: { rm: string }; Returns: string };
      pin_message: { Args: { msg: string; hours: number }; Returns: undefined };
      platform_workspaces: { Args: Record<PropertyKey, never>; Returns: { id: string; name: string; theme: string; avatar_url: string; members: number; admins: number; joined: boolean }[] };
      postit_arrival: { Args: { uid: string; ch: string }; Returns: string };
      purge_old_documents: { Args: Record<PropertyKey, never>; Returns: undefined };
      remove_push_subscription: { Args: { p_endpoint: string }; Returns: undefined };
      save_push_subscription: { Args: { p_endpoint: string; p_p256dh: string; p_auth: string; p_user_agent?: string }; Returns: undefined };
      search_messages: { Args: { needle: string; in_channel?: string; max_rows?: number }; Returns: { id: string; channel_id: string; user_id: string; body: string; created_at: string }[] };
      set_todo_item: { Args: { p_id: string; p_index: number; p_done: boolean }; Returns: undefined };
      shares_workspace_with: { Args: { other: string }; Returns: boolean };
      staff_has_as: { Args: { uid: string; rm: string; wanted: string[]; with_sheet_read: boolean }; Returns: boolean };
      tag_room: { Args: { tag: string }; Returns: string };
      unpin_message: { Args: { msg: string }; Returns: undefined };
      unread_counts_for: { Args: { uid: string }; Returns: { channel_id: string; workspace_id: string; unread: number }[] };
      user_id_by_email: { Args: { p_email: string }; Returns: string };
      user_in_channel_workspace: { Args: { ch: string; uid: string }; Returns: boolean };
      user_in_room_workspace: { Args: { rm: string; uid: string }; Returns: boolean };
      ws_admin_as: { Args: { uid: string; ws: string }; Returns: boolean };
      ws_member_as: { Args: { uid: string; ws: string }; Returns: boolean };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
}
