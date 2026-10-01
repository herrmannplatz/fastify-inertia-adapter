<script setup lang="ts">
import { Head } from '@inertiajs/vue3'
import Layout from '../Layout.vue'

defineProps<{ greeting: string }>()
</script>

<template>
  <Head title="Home" />
  <Layout>
    <h1>{{ greeting }}</h1>
  </Layout>
</template>
