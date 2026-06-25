<script setup lang="ts">
import { Eventra } from "@eventra_dev/eventra-sdk";

const tracker = new Eventra({ apiKey: "test" });

tracker.track("checkout.started");

function onSubmit() {
  tracker.track("checkout.submit");
}
</script>

<template>
  <button type="button" event="checkout.cta" @click="onSubmit">
    Pay
  </button>
</template>
